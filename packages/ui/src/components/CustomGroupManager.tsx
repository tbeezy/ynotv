import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { createPortal } from 'react-dom';
import { db, type StoredChannel, type StoredCategory } from '../db';
import { buildSearchQueryClauses } from '../utils/searchNormalization';
import { addChannelsToGroup, removeChannelsFromGroup, reorderGroupChannels, renameCustomGroup } from '../services/custom-groups';
import { useSettingsStore } from '../stores/settingsStore';
import './CustomGroupManager.css';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface CustomGroupManagerProps {
    groupId: string;
    groupName: string;
    onClose: () => void;
}

type GroupChannel = StoredChannel & { displayOrder: number };

function SortableGroupChannelItem(props: {
    ch: GroupChannel;
    displaySource: boolean;
    getChannelSourceCategory: (ch: GroupChannel) => string;
    handleRemove: (streamId: string) => void;
    dropIndicator?: 'above' | 'below' | null;
}) {
    const { ch, displaySource, getChannelSourceCategory, handleRemove, dropIndicator = null } = props;
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: ch.stream_id });

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
            {...attributes}
            {...listeners}
            className={`group-channel-item${isDragging ? ' dragging' : ''}${dropIndicator ? ` drop-${dropIndicator}` : ''}`}
        >
            {ch.stream_icon
                ? <img src={ch.stream_icon} className="cgm-ch-logo" alt="" />
                : <span className="cgm-ch-logo-placeholder">📺</span>
            }
            <div className="cgm-ch-info">
                <span className="cgm-ch-name">{ch.name}</span>
                {displaySource && (
                    <span className="cgm-ch-source">{getChannelSourceCategory(ch)}</span>
                )}
            </div>
            <button
                className="remove-btn"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => handleRemove(ch.stream_id)}
            >✕</button>
        </div>
    );
}

function parseCategoryIds(raw: string | string[] | number[] | undefined): string[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(String);
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* not JSON */ }
    if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
    return [String(raw)];
}

// ── SearchResults ─────────────────────────────────────────────────────────────

interface SearchResultsProps {
    query: string;
    groupChannelIds: Set<string>;
    onAdd: (ch: StoredChannel) => void;
    onRemove: (streamId: string) => void;
    enabledSourceIdsKey: string;
    enabledSourceIds: Set<string> | undefined;
    sources: any[];
}

function SearchResults({ query, groupChannelIds, onAdd, onRemove, enabledSourceIdsKey, enabledSourceIds, sources }: SearchResultsProps) {
  const { t } = useTranslation('customGroup');
    const [results, setResults] = useState<StoredChannel[] | undefined>();

    useEffect(() => {
        let isMounted = true;
        if (!query || query.length < 3) { setResults([]); return; }

        async function search() {
            try {
                // maxSearchResults is a settings-store field — read it synchronously
                // instead of paying an IPC getSettings round-trip.
                const maxSearchResults = useSettingsStore.getState().maxSearchResults ?? 200;

                console.log('[CustomGroupManager] Searching for:', query);

                // Get enabled category IDs for category filtering
                let enabledCategoryIds: Set<string> | null = null;
                if (enabledSourceIds && enabledSourceIds.size > 0) {
                    const allCategories = await db.categories.toArray();
                    enabledCategoryIds = new Set(
                        allCategories
                            .filter(c => enabledSourceIds.has(String(c.source_id)) && c.enabled !== false)
                            .map(c => c.category_id)
                    );
                }

                // Use case-insensitive search by lowercasing both sides
                const { sql: wordClauses, params: wordParams } = buildSearchQueryClauses('name', query);
                let all: StoredChannel[];
                if (enabledSourceIds && enabledSourceIds.size > 0) {
                    const sourceList = Array.from(enabledSourceIds);
                    const placeholders = sourceList.map(() => '?').join(',');
                    all = await db.channels.whereRaw(
                        `(${wordClauses}) AND source_id IN (${placeholders})`,
                        [...wordParams, ...sourceList]
                    ).limit(maxSearchResults).toArray();
                } else {
                    all = await db.channels.whereRaw(wordClauses, wordParams).limit(maxSearchResults).toArray();
                }
                console.log('[CustomGroupManager] Raw results:', all.length, 'for query:', query);


                const filtered = all.filter(c => {
                    if (c.enabled === false) return false;
                    // Source filtering is now done in SQL query
                    // Filter out channels that don't belong to any enabled category
                    if (enabledCategoryIds && enabledCategoryIds.size > 0) {
                        const catIds = parseCategoryIds(c.category_ids);
                        // Convert to strings for comparison since category_ids may be numbers in JSON
                        const hasEnabledCategory = catIds.some(id => enabledCategoryIds!.has(String(id)));
                        if (!hasEnabledCategory) return false;
                    }
                    return true;
                }).slice(0, maxSearchResults);
                console.log('[CustomGroupManager] Filtered results:', filtered.length, 'for query:', query);
                if (isMounted) setResults(filtered);
            } catch (err) {
                console.error('[CustomGroupManager] Search error:', err);
                if (isMounted) setResults([]);
            }
        }

        search();
        return () => { isMounted = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, enabledSourceIdsKey]);

    if (!results) return <div className="cgm-empty">{t('searching')}</div>;
    if (results.length === 0) return <div className="cgm-empty">{t('noResultsFor', { query })}</div>;

    // Group results by source
    const sourceNameMap = new Map(sources.map(s => [s.id, s.name]));
    const groupedBySource = new Map<string, StoredChannel[]>();

    for (const ch of results) {
        const sourceChannels = groupedBySource.get(ch.source_id) || [];
        sourceChannels.push(ch);
        groupedBySource.set(ch.source_id, sourceChannels);
    }

    return (
        <div className="tree-root">
            {Array.from(groupedBySource.entries()).map(([sourceId, channels]) => (
                <div key={sourceId} className="tree-node source-wrapper">
                    <div className="tree-node-header source-node">
                        <span className="node-icon">▼</span>
                        <span>{sourceNameMap.get(sourceId) || t('unknownSource')}</span>
                        <span className="cgm-count">{channels.length}</span>
                    </div>
                    <div className="node-children">
                        {channels.map(ch => {
                            const inGroup = groupChannelIds.has(ch.stream_id);
                            return (
                                <div key={ch.stream_id} className={`channel-node${inGroup ? ' in-group' : ''}`}
                                    onClick={() => inGroup ? onRemove(ch.stream_id) : onAdd(ch)}>
                                    <span className="cgm-check">{inGroup ? '✓' : '+'}</span>
                                    {ch.stream_icon && <img src={ch.stream_icon} className="channel-node-logo" alt="" />}
                                    <span className="channel-node-label">{ch.name}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}

// ── TreeView ──────────────────────────────────────────────────────────────────

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
  const { t } = useTranslation('customGroup');
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
            loadedCats.current.delete(categoryId);
        } finally {
            setLoadingNode(null);
        }
    }, []);

    if (!sourcesAndCategories) return <div className="cgm-empty">{t('loadingSources')}</div>;

    const { sources, categories } = sourcesAndCategories;

    if (searchQuery.length > 2) {
        return <SearchResults query={searchQuery} groupChannelIds={groupChannelIds} onAdd={onAdd} onRemove={onRemove} enabledSourceIdsKey={enabledSourceIdsKey} enabledSourceIds={enabledSourceIds} sources={sources} />;
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
                                            <div className="tree-node-header category-node"
                                                onClick={() => {
                                                    toggleNode(cat.category_id);
                                                    if (!isCatExpanded) loadCategoryChannels(cat.category_id, source.id);
                                                }}>
                                                <span className="node-icon">{isCatExpanded ? '▼' : '▶'}</span>
                                                <span>{cat.category_name}</span>
                                                {catChannels.length > 0 && <span className="cgm-count">{catChannels.length}</span>}
                                            </div>
                                            {isCatExpanded && (
                                                <div className="node-children">
                                                    {loadingNode === cat.category_id && catChannels.length === 0 && <div className="cgm-empty">{t('loading')}</div>}
                                                    {loadingNode !== cat.category_id && catChannels.length === 0 && <div className="cgm-empty">{t('noChannels')}</div>}
                                                    {catChannels.map(ch => {
                                                        const inGroup = groupChannelIds.has(ch.stream_id);
                                                        return (
                                                            <div key={ch.stream_id} className={`channel-node${inGroup ? ' in-group' : ''}`}
                                                                onClick={() => inGroup ? onRemove(ch.stream_id) : onAdd(ch)}>
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

// ── SortableList: container-level pointer tracking for drag reorder ────────────
// This approach works in Tauri/WebView2 because:
// 1. We use pointerdown on the handle to start drag
// 2. We attach pointermove/pointerup to the *container* div (not individual items)
// 3. We compute target index from the mouse Y position vs each item's bounding rect

// ── Main CustomGroupManager ───────────────────────────────────────────────────

export function CustomGroupManager({ groupId, groupName, onClose }: CustomGroupManagerProps) {
    const { t } = useTranslation('customGroup');
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 5,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    const [activeDragId, setActiveDragId] = useState<string | null>(null);
    const [overDragId, setOverDragId] = useState<string | null>(null);

    const handleDragStart = useCallback((event: DragStartEvent) => {
        setActiveDragId(String(event.active.id));
    }, []);

    const handleDragOver = useCallback((event: DragOverEvent) => {
        if (event.over && event.active.id !== event.over.id) {
            setOverDragId(String(event.over.id));
        } else {
            setOverDragId(null);
        }
    }, []);

    const handleDragCancel = useCallback(() => {
        setActiveDragId(null);
        setOverDragId(null);
    }, []);

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveDragId(null);
        setOverDragId(null);
        if (!over || active.id === over.id || !groupChannels) return;

        const oldIndex = groupChannels.findIndex((ch) => ch.stream_id === active.id);
        const newIndex = groupChannels.findIndex((ch) => ch.stream_id === over.id);

        if (oldIndex === -1 || newIndex === -1) return;

        const next = arrayMove(groupChannels, oldIndex, newIndex);
        handleReorder(next);
    };

    const [searchQuery, setSearchQuery] = useState('');
    const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
    const [groupChannels, setGroupChannels] = useState<GroupChannel[]>([]);
    const [sourcesAndCategories, setSourcesAndCategories] = useState<{ sources: any[]; categories: StoredCategory[]; enabledSourceIds: Set<string> } | undefined>();
    const [loading, setLoading] = useState(true);

    // Display source/category for each channel
    const [displaySource, setDisplaySource] = useState(false);

    // Rename state
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(groupName);
    const [currentName, setCurrentName] = useState(groupName);
    const renameInputRef = useRef<HTMLInputElement>(null);

    const groupChannelIds = new Set(groupChannels.map(c => c.stream_id));
    const enabledSourceIdsKey = sourcesAndCategories
        ? Array.from(sourcesAndCategories.enabledSourceIds).sort().join(',')
        : '';

    // Lookup maps for source/category display
    const sourceNameMap = React.useMemo(() => {
        if (!sourcesAndCategories) return new Map<string, string>();
        return new Map(sourcesAndCategories.sources.map((s: any) => [String(s.id), s.name]));
    }, [sourcesAndCategories]);

    const categoryNameMap = React.useMemo(() => {
        if (!sourcesAndCategories) return new Map<string, string>();
        return new Map(sourcesAndCategories.categories.map(c => [String(c.category_id), c.category_name]));
    }, [sourcesAndCategories]);

    const getChannelSourceCategory = (ch: GroupChannel): string => {
        const sourceName = sourceNameMap.get(String(ch.source_id)) || ch.source_id || t('unknown');
        const catIds = parseCategoryIds(ch.category_ids);
        const catName = catIds.length > 0 ? (categoryNameMap.get(String(catIds[0])) || catIds[0]) : '—';
        return `${sourceName} → ${catName}`;
    };

    useEffect(() => {
        let isMounted = true;
        setLoading(true);
        async function loadData() {
            try {
                const mappings = await db.customGroupChannels.where('group_id').equals(groupId).sortBy('display_order');
                const streamIds = mappings.map(m => m.stream_id);
                const chs = streamIds.length > 0 ? await db.channels.where('stream_id').anyOf(streamIds).toArray() : [];
                const channelMap = new Map(chs.map(c => [c.stream_id, c]));
                const ordered: GroupChannel[] = mappings
                    .map((m, i) => ({ ...channelMap.get(m.stream_id)!, displayOrder: m.display_order ?? i }))
                    .filter(c => c.stream_id);
                if (isMounted) setGroupChannels(ordered);

                const sourcesResult = await window.storage.getSources();
                const allSources = (sourcesResult.data || []).filter((s: any) => s.enabled !== false);
                const enabledSourceIds = new Set(allSources.map((s: any) => String(s.id)));
                const allCategories = await db.categories.toArray();
                const filteredCats = allCategories.filter(c => enabledSourceIds.has(String(c.source_id)) && c.enabled !== false);
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

    const handleAdd = useCallback(async (ch: StoredChannel) => {
        if (groupChannelIds.has(ch.stream_id)) return;
        setGroupChannels(prev => [...prev, { ...ch, displayOrder: prev.length }]);
        try { await addChannelsToGroup(groupId, [ch.stream_id]); }
        catch (e) { console.error('Failed to add:', e); setGroupChannels(prev => prev.filter(c => c.stream_id !== ch.stream_id)); }
    }, [groupId, groupChannelIds]);

    const handleRemove = useCallback(async (streamId: string) => {
        setGroupChannels(prev => prev.filter(c => c.stream_id !== streamId));
        try { await removeChannelsFromGroup(groupId, [streamId]); }
        catch (e) { console.error('Failed to remove:', e); }
    }, [groupId]);

    const handleReorder = useCallback(async (newItems: GroupChannel[]) => {
        setGroupChannels(newItems);
        try { await reorderGroupChannels(groupId, newItems.map(c => c.stream_id)); }
        catch (e) { console.error('Failed to reorder:', e); }
    }, [groupId]);

    const toggleNode = (nodeId: string) => setExpandedNodes(prev => ({ ...prev, [nodeId]: !prev[nodeId] }));

    const startRename = () => {
        setRenameValue(currentName);
        setIsRenaming(true);
        setTimeout(() => renameInputRef.current?.select(), 50);
    };

    const commitRename = async () => {
        const trimmed = renameValue.trim();
        if (trimmed && trimmed !== currentName) {
            try {
                await renameCustomGroup(groupId, trimmed);
                setCurrentName(trimmed);
            } catch (e) { console.error('Failed to rename:', e); }
        }
        setIsRenaming(false);
    };

    const handleRenameKey = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') commitRename();
        if (e.key === 'Escape') setIsRenaming(false);
    };

    const handleSortABC = useCallback(async () => {
        if (groupChannels.length === 0) return;
        const sorted = [...groupChannels].sort((a, b) => {
            const nameA = (a.alias || a.name || '').trim();
            const nameB = (b.alias || b.name || '').trim();
            return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
        });
        const updated = sorted.map((c, idx) => ({ ...c, displayOrder: idx }));
        setGroupChannels(updated);
        try {
            await reorderGroupChannels(groupId, updated.map(c => c.stream_id));
        } catch (e) {
            console.error('Failed to reorder group channels:', e);
        }
    }, [groupChannels, groupId]);

    return createPortal(
        <div className="custom-group-manager-overlay" onClick={onClose}>
            <div className="custom-group-manager-modal" onClick={e => e.stopPropagation()}>

                <div className="custom-group-manager-header">
                    {isRenaming ? (
                        <div className="cgm-rename-row">
                            <input ref={renameInputRef} className="cgm-rename-input" value={renameValue}
                                onChange={e => setRenameValue(e.target.value)} onKeyDown={handleRenameKey} onBlur={commitRename} autoFocus />
                            <button className="cgm-rename-ok" onClick={commitRename}>✓</button>
                        </div>
                    ) : (
                        <div className="cgm-title-row">
                            <h2>{currentName}</h2>
                            <button className="cgm-rename-btn" onClick={startRename} title={t('renameGroup')}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                    <path d="m15 5 4 4" />
                                </svg>
                            </button>
                        </div>
                    )}
                    <button className="close-btn" onClick={onClose}>✕</button>
                </div>

                <div className="custom-group-content">

                    {/* Left Pane: Group Channels (sortable via container pointer tracking) */}
                    <div className="group-channels-pane">
                        <div className="pane-header">
                            <span>{t('inGroup')}</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <button
                                    className="cgm-sort-abc-btn"
                                    onClick={handleSortABC}
                                    title={t('sortAbcTitle')}
                                    style={{
                                        padding: '2px 8px',
                                        fontSize: '0.78rem',
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
                                    🔤 {t('sortAbc')}
                                </button>
                                <label className="cgm-display-source-label" title={t('displaySourceTitle')}>
                                    <input
                                        type="checkbox"
                                        checked={displaySource}
                                        onChange={e => setDisplaySource(e.target.checked)}
                                    />
                                    {t('displaySource')}
                                </label>
                                <span className="cgm-badge">{groupChannels.length}</span>
                            </div>
                        </div>
                        {groupChannels.length === 0 && !loading
                            ? <div className="cgm-empty" style={{ padding: '20px 16px' }}>{t('clickToAdd')}</div>
                            : (
                                <DndContext
                                    sensors={sensors}
                                    collisionDetection={closestCenter}
                                    onDragStart={handleDragStart}
                                    onDragOver={handleDragOver}
                                    onDragCancel={handleDragCancel}
                                    onDragEnd={handleDragEnd}
                                >
                                    <SortableContext
                                        items={groupChannels.map((ch) => ch.stream_id)}
                                        strategy={verticalListSortingStrategy}
                                    >
                                        <div className="channel-list-container">
                                            {groupChannels.map((ch) => {
                                                const activeIndex = activeDragId ? groupChannels.findIndex(c => c.stream_id === activeDragId) : -1;
                                                const overIndex = overDragId ? groupChannels.findIndex(c => c.stream_id === overDragId) : -1;
                                                const isOver = overDragId === ch.stream_id && activeDragId !== overDragId;
                                                const dropIndicator = isOver ? (activeIndex < overIndex ? 'below' : 'above') : null;
                                                return (
                                                    <SortableGroupChannelItem
                                                        key={ch.stream_id}
                                                        ch={ch}
                                                        displaySource={displaySource}
                                                        getChannelSourceCategory={getChannelSourceCategory}
                                                        handleRemove={handleRemove}
                                                        dropIndicator={dropIndicator}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </SortableContext>
                                </DndContext>
                            )
                        }
                    </div>

                    {/* Right Pane: Source/Category Tree Selector */}
                    <div className="source-selector-pane">
                        <div className="search-bar">
                            <input type="text" placeholder={t('searchPlaceholder')} value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)} autoComplete="off" />
                        </div>
                        <div className="selector-content">
                            {loading
                                ? <div className="cgm-empty">{t('loading')}</div>
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
                    <span className="cgm-footer-hint">{t('footerHint')}</span>
                    <button className="close-done-btn" onClick={onClose}>{i18n.t('common:done')}</button>
                </div>

            </div>
        </div>,
        document.body
    );
}
