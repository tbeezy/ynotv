import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db, type StoredChannel, type StoredCategory } from '../db';
import { addChannelsToGroup, removeChannelsFromGroup, reorderGroupChannels } from '../services/custom-groups';
import './CustomGroupManager.css';

interface CustomGroupManagerProps {
    groupId: string;
    groupName: string;
    onClose: () => void;
}

type GroupChannel = StoredChannel & { displayOrder: number };

// Parse category_ids from JSON string or array — handles both ["123"] and [123] formats
function parseCategoryIds(raw: string | string[] | number[] | undefined): string[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(String);
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* not JSON */ }
    if (typeof raw === 'string') {
        return raw.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [String(raw)];
}

// ─── SearchResults (module-level to prevent remount on parent re-render) ───

interface SearchResultsProps {
    query: string;
    groupChannelIds: Set<string>;
    onAdd: (ch: StoredChannel) => void;
    onRemove: (streamId: string) => void;
    enabledSourceIdsKey: string;
    enabledSourceIds: Set<string> | undefined;
}

function SearchResults({ query, groupChannelIds, onAdd, onRemove, enabledSourceIdsKey, enabledSourceIds }: SearchResultsProps) {
    const [results, setResults] = useState<StoredChannel[] | undefined>();

    useEffect(() => {
        let isMounted = true;
        if (!query || query.length < 3) { setResults([]); return; }

        db.channels.whereRaw('name LIKE ?', [`%${query}%`]).limit(200).toArray().then(all => {
            const filtered = all.filter(c => {
                if (c.enabled === false) return false;
                if (enabledSourceIds && !enabledSourceIds.has(String(c.source_id))) return false;
                return true;
            }).slice(0, 100);
            if (isMounted) setResults(filtered);
        }).catch(() => { if (isMounted) setResults([]); });

        return () => { isMounted = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, enabledSourceIdsKey]);

    if (!results) return <div className="cgm-empty">Searching...</div>;
    if (results.length === 0) return <div className="cgm-empty">No results for "{query}"</div>;

    return (
        <div className="tree-root">
            {results.map(ch => {
                const inGroup = groupChannelIds.has(ch.stream_id);
                return (
                    <div
                        key={ch.stream_id}
                        className={`channel-node${inGroup ? ' in-group' : ''}`}
                        onClick={() => inGroup ? onRemove(ch.stream_id) : onAdd(ch)}
                    >
                        <span className="cgm-check">{inGroup ? '✓' : '+'}</span>
                        {ch.stream_icon && <img src={ch.stream_icon} className="channel-node-logo" alt="" />}
                        <span className="channel-node-label">{ch.name}</span>
                    </div>
                );
            })}
        </div>
    );
}

// ─── TreeView (module-level to prevent remount on parent re-render) ───

interface TreeViewProps {
    sourcesAndCategories: { sources: any[]; categories: StoredCategory[]; enabledSourceIds: Set<string> } | undefined;
    searchQuery: string;
    expandedNodes: Record<string, boolean>;
    toggleNode: (id: string) => void;
    groupChannelIds: Set<string>;
    onAdd: (ch: StoredChannel) => void;
    onRemove: (streamId: string) => void;
    enabledSourceIdsKey: string;
    enabledSourceIds: Set<string> | undefined;
}

function TreeView({ sourcesAndCategories, searchQuery, expandedNodes, toggleNode, groupChannelIds, onAdd, onRemove, enabledSourceIdsKey, enabledSourceIds }: TreeViewProps) {
    const [loadedChannels, setLoadedChannels] = useState<StoredChannel[]>([]);
    const [loadingNode, setLoadingNode] = useState<string | null>(null);
    const loadedCats = useRef<Set<string>>(new Set());

    const loadCategoryChannels = useCallback(async (categoryId: string, sourceId: string) => {
        if (loadedCats.current.has(categoryId)) return;
        loadedCats.current.add(categoryId);
        setLoadingNode(categoryId);
        try {
            const allChs = await db.channels.whereRaw('source_id = ?', [sourceId]).toArray();
            const matching = allChs.filter(c => {
                if (c.enabled === false) return false;
                return parseCategoryIds(c.category_ids).includes(String(categoryId));
            });
            setLoadedChannels(prev => {
                const existing = new Set(prev.map(p => p.stream_id));
                const uniqueNew = matching.filter(c => !existing.has(c.stream_id));
                return [...prev, ...uniqueNew];
            });
        } catch (e) {
            console.error('Failed to load channels:', e);
            loadedCats.current.delete(categoryId); // allow retry
        } finally {
            setLoadingNode(null);
        }
    }, []);

    if (!sourcesAndCategories) return <div className="cgm-empty">Loading sources…</div>;

    if (searchQuery.length > 2) {
        return <SearchResults query={searchQuery} groupChannelIds={groupChannelIds} onAdd={onAdd} onRemove={onRemove} enabledSourceIdsKey={enabledSourceIdsKey} enabledSourceIds={enabledSourceIds} />;
    }

    const { sources, categories } = sourcesAndCategories;

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
                            <span className="cgm-count">{sourceCats.length} cats</span>
                        </div>

                        {isExpanded && (
                            <div className="node-children">
                                {sourceCats.map(cat => {
                                    const isCatExpanded = expandedNodes[cat.category_id];
                                    const catChannels = loadedChannels.filter(c =>
                                        parseCategoryIds(c.category_ids).includes(String(cat.category_id))
                                    );
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
                                                {catChannels.length > 0 && <span className="cgm-count">{catChannels.length}</span>}
                                            </div>

                                            {isCatExpanded && (
                                                <div className="node-children">
                                                    {loadingNode === cat.category_id && catChannels.length === 0 && (
                                                        <div className="cgm-empty">Loading…</div>
                                                    )}
                                                    {loadingNode !== cat.category_id && catChannels.length === 0 && (
                                                        <div className="cgm-empty">No channels</div>
                                                    )}
                                                    {catChannels.map(ch => {
                                                        const inGroup = groupChannelIds.has(ch.stream_id);
                                                        return (
                                                            <div
                                                                key={ch.stream_id}
                                                                className={`channel-node${inGroup ? ' in-group' : ''}`}
                                                                onClick={() => inGroup ? onRemove(ch.stream_id) : onAdd(ch)}
                                                            >
                                                                <span className="cgm-check">{inGroup ? '✓' : '+'}</span>
                                                                {ch.stream_icon && <img src={ch.stream_icon} className="channel-node-logo" alt="" />}
                                                                <span className="channel-node-label">{ch.name}</span>
                                                            </div>
                                                        );
                                                    })}
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
}

// ─── Main CustomGroupManager component ───

export function CustomGroupManager({ groupId, groupName, onClose }: CustomGroupManagerProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
    const [groupChannels, setGroupChannels] = useState<GroupChannel[]>([]);
    const [sourcesAndCategories, setSourcesAndCategories] = useState<{ sources: any[]; categories: StoredCategory[]; enabledSourceIds: Set<string> } | undefined>();
    const [loading, setLoading] = useState(true);

    // Drag state refs (no re-render needed)
    const dragIndexRef = useRef<number | null>(null);
    const dragOverIndexRef = useRef<number | null>(null);

    const groupChannelIds = new Set(groupChannels.map(c => c.stream_id));

    const enabledSourceIdsKey = sourcesAndCategories
        ? Array.from(sourcesAndCategories.enabledSourceIds).sort().join(',')
        : '';

    // Load initial data
    useEffect(() => {
        let isMounted = true;
        setLoading(true);

        async function loadData() {
            try {
                const mappings = await db.customGroupChannels
                    .where('group_id').equals(groupId)
                    .sortBy('display_order');

                const streamIds = mappings.map(m => m.stream_id);
                const chs = streamIds.length > 0
                    ? await db.channels.where('stream_id').anyOf(streamIds).toArray()
                    : [];
                const channelMap = new Map(chs.map(c => [c.stream_id, c]));

                // Preserve display_order from mappings
                const ordered: GroupChannel[] = mappings
                    .map((m, i) => ({ ...channelMap.get(m.stream_id)!, displayOrder: m.display_order ?? i }))
                    .filter(c => c.stream_id);

                if (isMounted) setGroupChannels(ordered);

                const sourcesResult = await window.storage.getSources();
                const allSources = (sourcesResult.data || []).filter((s: any) => s.enabled !== false);
                const enabledSourceIds = new Set(allSources.map((s: any) => String(s.id)));

                const allCategories = await db.categories.toArray();
                const filteredCats = allCategories.filter(c =>
                    enabledSourceIds.has(String(c.source_id)) && c.enabled !== false
                );

                if (isMounted) {
                    setSourcesAndCategories({ sources: allSources, categories: filteredCats, enabledSourceIds });
                    setLoading(false);
                }
            } catch (err) {
                console.error('Failed to load group manager data:', err);
                if (isMounted) setLoading(false);
            }
        }

        loadData();
        return () => { isMounted = false; };
    }, [groupId]);

    // Add a channel immediately
    const handleAdd = useCallback(async (ch: StoredChannel) => {
        if (groupChannelIds.has(ch.stream_id)) return;
        const nextOrder = groupChannels.length;
        setGroupChannels(prev => [...prev, { ...ch, displayOrder: nextOrder }]);
        try {
            await addChannelsToGroup(groupId, [ch.stream_id]);
        } catch (e) {
            console.error('Failed to add channel:', e);
            setGroupChannels(prev => prev.filter(c => c.stream_id !== ch.stream_id));
        }
    }, [groupId, groupChannels, groupChannelIds]);

    // Remove a channel immediately
    const handleRemove = useCallback(async (streamId: string) => {
        setGroupChannels(prev => prev.filter(c => c.stream_id !== streamId));
        try {
            await removeChannelsFromGroup(groupId, [streamId]);
        } catch (e) {
            console.error('Failed to remove channel:', e);
            // Reload on failure
            window.location.reload();
        }
    }, [groupId]);

    const toggleNode = (nodeId: string) => {
        setExpandedNodes(prev => ({ ...prev, [nodeId]: !prev[nodeId] }));
    };

    // ── Drag and drop handlers ──
    const handleDragStart = (e: React.DragEvent, index: number) => {
        dragIndexRef.current = index;
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleDragOver = (e: React.DragEvent, index: number) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        dragOverIndexRef.current = index;
    };

    const handleDrop = async (e: React.DragEvent, dropIndex: number) => {
        e.preventDefault();
        const from = dragIndexRef.current;
        if (from === null || from === dropIndex) return;

        const reordered = [...groupChannels];
        const [moved] = reordered.splice(from, 1);
        reordered.splice(dropIndex, 0, moved);
        setGroupChannels(reordered);

        dragIndexRef.current = null;
        dragOverIndexRef.current = null;

        try {
            await reorderGroupChannels(groupId, reordered.map(c => c.stream_id));
        } catch (e) {
            console.error('Failed to reorder:', e);
        }
    };

    const handleDragEnd = () => {
        dragIndexRef.current = null;
        dragOverIndexRef.current = null;
    };

    return (
        <div className="custom-group-manager-overlay" onClick={onClose}>
            <div className="custom-group-manager-modal" onClick={e => e.stopPropagation()}>

                <div className="custom-group-manager-header">
                    <h2>Manage: {groupName}</h2>
                    <button className="close-btn" onClick={onClose}>✕</button>
                </div>

                <div className="custom-group-content">

                    {/* Left Pane: Group Channels */}
                    <div className="group-channels-pane">
                        <div className="pane-header">
                            <span>In Group</span>
                            <span className="cgm-badge">{groupChannels.length}</span>
                        </div>
                        <div className="channel-list-container">
                            {groupChannels.length === 0 && !loading && (
                                <div className="cgm-empty">Click channels on the right to add them here.</div>
                            )}
                            {groupChannels.map((ch, index) => (
                                <div
                                    key={ch.stream_id}
                                    className="group-channel-item"
                                    draggable
                                    onDragStart={e => handleDragStart(e, index)}
                                    onDragOver={e => handleDragOver(e, index)}
                                    onDrop={e => handleDrop(e, index)}
                                    onDragEnd={handleDragEnd}
                                >
                                    <span className="drag-handle" title="Drag to reorder">⋮⋮</span>
                                    {ch.stream_icon
                                        ? <img src={ch.stream_icon} className="cgm-ch-logo" alt="" />
                                        : <span className="cgm-ch-logo-placeholder">📺</span>
                                    }
                                    <span className="cgm-ch-name">{ch.name}</span>
                                    <button
                                        className="remove-btn"
                                        onClick={() => handleRemove(ch.stream_id)}
                                        title="Remove from group"
                                    >✕</button>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Right Pane: Source/Category Selector */}
                    <div className="source-selector-pane">
                        <div className="search-bar">
                            <input
                                type="text"
                                placeholder="Search channels…"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                autoComplete="off"
                            />
                        </div>
                        <div className="selector-content">
                            {loading
                                ? <div className="cgm-empty">Loading…</div>
                                : <TreeView
                                    sourcesAndCategories={sourcesAndCategories}
                                    searchQuery={searchQuery}
                                    expandedNodes={expandedNodes}
                                    toggleNode={toggleNode}
                                    groupChannelIds={groupChannelIds}
                                    onAdd={handleAdd}
                                    onRemove={handleRemove}
                                    enabledSourceIdsKey={enabledSourceIdsKey}
                                    enabledSourceIds={sourcesAndCategories?.enabledSourceIds}
                                />
                            }
                        </div>
                    </div>

                </div>

                <div className="custom-group-manager-footer">
                    <span className="cgm-footer-hint">Changes are saved instantly. Drag ⋮⋮ to reorder.</span>
                    <button className="close-done-btn" onClick={onClose}>Done</button>
                </div>

            </div>
        </div>
    );
}
