import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { db, type StoredChannel, type StoredCategory } from '../db';
import { buildSearchQueryClauses } from '../utils/searchNormalization';
import { useSettingsStore } from '../stores/settingsStore';
import {
    addChannelToFailoverGroup,
    removeChannelFromFailoverGroup,
    reorderFailoverGroupChannels,
    renameFailoverGroup,
    getFailoverGroupMembers,
} from '../services/failover-groups';
import './CustomGroupManager.css'; // Reuse the same styles

interface FailoverGroupManagerProps {
    groupId: string;
    groupName: string;
    onClose: () => void;
}

type GroupChannel = StoredChannel & { priority: number };

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
    const { t } = useTranslation('settings');
    const [results, setResults] = useState<StoredChannel[] | undefined>();

    useEffect(() => {
        let isMounted = true;
        if (!query || query.length < 3) { setResults([]); return; }

        async function search() {
            try {
                // maxSearchResults is a settings-store field — read it synchronously
                // instead of paying an IPC getSettings round-trip.
                const maxSearchResults = useSettingsStore.getState().maxSearchResults ?? 200;

                let enabledCategoryIds: Set<string> | null = null;
                if (enabledSourceIds && enabledSourceIds.size > 0) {
                    const allCategories = await db.categories.toArray();
                    enabledCategoryIds = new Set(
                        allCategories
                            .filter(c => enabledSourceIds.has(String(c.source_id)) && c.enabled !== false)
                            .map(c => c.category_id)
                    );
                }

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

                const filtered = all.filter(c => {
                    if (c.enabled === false) return false;
                    if (enabledCategoryIds && enabledCategoryIds.size > 0) {
                        const catIds = parseCategoryIds(c.category_ids);
                        const hasEnabledCategory = catIds.some(id => enabledCategoryIds!.has(String(id)));
                        if (!hasEnabledCategory) return false;
                    }
                    return true;
                }).slice(0, maxSearchResults);
                if (isMounted) setResults(filtered);
            } catch (err) {
                console.error('[FailoverGroupManager] Search error:', err);
                if (isMounted) setResults([]);
            }
        }

        search();
        return () => { isMounted = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, enabledSourceIdsKey]);

    if (!results) return <div className="cgm-empty">{t('failover.searching')}</div>;
    if (results.length === 0) return <div className="cgm-empty">{t('failover.noResults', { query })}</div>;

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
                        <span>{sourceNameMap.get(sourceId) || 'Unknown Source'}</span>
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
    const { t } = useTranslation('settings');
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

    if (!sourcesAndCategories) return <div className="cgm-empty">{t('failover.loadingSources')}</div>;

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
                            <span className="cgm-count">{t('failover.catsCount', { count: sourceCats.length })}</span>
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
                                                    {loadingNode === cat.category_id && catChannels.length === 0 && <div className="cgm-empty">{t('failover.loadingTree')}</div>}
                                                    {loadingNode !== cat.category_id && catChannels.length === 0 && <div className="cgm-empty">{t('failover.noChannels')}</div>}
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

interface SortableListProps<T> {
    items: T[];
    getKey: (item: T) => string;
    onReorder: (newItems: T[]) => void;
    renderItem: (item: T, index: number, handleProps: React.HTMLAttributes<HTMLSpanElement>) => React.ReactNode;
}

function SortableList<T>({ items, getKey, onReorder, renderItem }: SortableListProps<T>) {
    const containerRef = useRef<HTMLDivElement>(null);
    const draggingIdx = useRef<number | null>(null);
    const [overIdx, setOverIdx] = useState<number | null>(null);
    const [fromIdx, setFromIdx] = useState<number | null>(null);

    const getIndexFromY = (clientY: number): number => {
        if (!containerRef.current) return 0;
        const children = Array.from(containerRef.current.children) as HTMLElement[];
        for (let i = 0; i < children.length; i++) {
            const rect = children[i].getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) return i;
        }
        return children.length - 1;
    };

    const handlePointerDown = (e: React.PointerEvent, index: number) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        draggingIdx.current = index;
        setFromIdx(index);
        setOverIdx(index);
    };

    const handleContainerPointerMove = (e: React.PointerEvent) => {
        if (draggingIdx.current === null) return;
        e.preventDefault();
        const idx = getIndexFromY(e.clientY);
        setOverIdx(idx);
    };

    const handleContainerPointerUp = (e: React.PointerEvent) => {
        if (draggingIdx.current === null) return;
        const from = draggingIdx.current;
        const to = overIdx ?? from;
        draggingIdx.current = null;
        setFromIdx(null);
        setOverIdx(null);
        if (from !== to) {
            const next = [...items];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            onReorder(next);
        }
    };

    const handleContainerPointerLeave = () => {
        // Don't cancel drag on leave — pointer capture handles keeping events
    };

    return (
        <div
            ref={containerRef}
            className="channel-list-container"
            onPointerMove={handleContainerPointerMove}
            onPointerUp={handleContainerPointerUp}
            onPointerLeave={handleContainerPointerLeave}
        >
            {items.map((item, index) => {
                const key = getKey(item);
                const isDragging = fromIdx === index;
                const isDragOver = overIdx === index && fromIdx !== null && fromIdx !== index;
                const handleProps: React.HTMLAttributes<HTMLSpanElement> = {
                    onPointerDown: (e: React.PointerEvent<HTMLSpanElement>) => handlePointerDown(e, index),
                    style: { cursor: 'grab', touchAction: 'none' },
                };
                return (
                    <div
                        key={key}
                        className="group-channel-item"
                        data-dragging={isDragging ? 'true' : undefined}
                        data-dragover={isDragOver ? 'true' : undefined}
                        style={{ opacity: isDragging ? 0.4 : 1 }}
                    >
                        {renderItem(item, index, handleProps)}
                    </div>
                );
            })}
        </div>
    );
}

// ── Main FailoverGroupManager ─────────────────────────────────────────────────

export function FailoverGroupManager({ groupId, groupName, onClose }: FailoverGroupManagerProps) {
    const { t } = useTranslation('settings');
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
    const [groupChannels, setGroupChannels] = useState<GroupChannel[]>([]);
    const [sourcesAndCategories, setSourcesAndCategories] = useState<{ sources: any[]; categories: StoredCategory[]; enabledSourceIds: Set<string> } | undefined>();
    const [loading, setLoading] = useState(true);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
        const sourceName = sourceNameMap.get(String(ch.source_id)) || ch.source_id || t('failover.unknown');
        const catIds = parseCategoryIds(ch.category_ids);
        const catName = catIds.length > 0 ? (categoryNameMap.get(String(catIds[0])) || catIds[0]) : '—';
        return `${sourceName} → ${catName}`;
    };

    useEffect(() => {
        let isMounted = true;
        setLoading(true);
        async function loadData() {
            try {
                const members = await getFailoverGroupMembers(groupId);
                const streamIds = members.map(m => m.stream_id);
                const chs = streamIds.length > 0 ? await db.channels.where('stream_id').anyOf(streamIds).toArray() : [];
                const channelMap = new Map(chs.map(c => [c.stream_id, c]));
                const ordered: GroupChannel[] = members
                    .map(m => {
                        const ch = channelMap.get(m.stream_id);
                        if (!ch) return null;
                        return { ...ch, priority: m.priority };
                    })
                    .filter((c): c is GroupChannel => c !== null);
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
                console.error('Failed to load failover group manager data:', err);
                if (isMounted) setLoading(false);
            }
        }
        loadData();
        return () => { isMounted = false; };
    }, [groupId]);

    const handleAdd = useCallback(async (ch: StoredChannel) => {
        if (groupChannelIds.has(ch.stream_id)) return;
        setErrorMsg(null);
        setGroupChannels(prev => [...prev, { ...ch, priority: prev.length }]);
        try {
            await addChannelToFailoverGroup(groupId, ch.stream_id);
        } catch (e: any) {
            console.error('Failed to add:', e);
            setErrorMsg(e.message || t('failover.failedAdd'));
            setGroupChannels(prev => prev.filter(c => c.stream_id !== ch.stream_id));
        }
    }, [groupId, groupChannelIds]);

    const handleRemove = useCallback(async (streamId: string) => {
        setGroupChannels(prev => prev.filter(c => c.stream_id !== streamId));
        try {
            await removeChannelFromFailoverGroup(streamId);
        } catch (e) {
            console.error('Failed to remove:', e);
        }
    }, []);

    const handleReorder = useCallback(async (newItems: GroupChannel[]) => {
        setGroupChannels(newItems);
        try {
            await reorderFailoverGroupChannels(groupId, newItems.map(c => c.stream_id));
        } catch (e) {
            console.error('Failed to reorder:', e);
        }
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
                await renameFailoverGroup(groupId, trimmed);
                setCurrentName(trimmed);
            } catch (e) { console.error('Failed to rename:', e); }
        }
        setIsRenaming(false);
    };

    const handleRenameKey = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') commitRename();
        if (e.key === 'Escape') setIsRenaming(false);
    };

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
                            <button className="cgm-rename-btn" onClick={startRename} title={t('failover.renameGroup')}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                    <path d="m15 5 4 4" />
                                </svg>
                            </button>
                        </div>
                    )}
                    <button className="close-btn" onClick={onClose}>✕</button>
                </div>

                {errorMsg && (
                    <div style={{ padding: '8px 24px', background: 'rgba(255, 92, 92, 0.15)', color: '#ff5c5c', fontSize: '0.85rem' }}>
                        {errorMsg}
                    </div>
                )}

                <div className="custom-group-content">

                    {/* Left Pane: Group Channels (sortable via container pointer tracking) */}
                    <div className="group-channels-pane">
                        <div className="pane-header">
                            <span>{t('failover.inGroup')}</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <label className="cgm-display-source-label" title={t('failover.displaySourceHint')}>
                                    <input
                                        type="checkbox"
                                        checked={displaySource}
                                        onChange={e => setDisplaySource(e.target.checked)}
                                    />
                                    {t('failover.displaySource')}
                                </label>
                                <span className="cgm-badge">{groupChannels.length}</span>
                            </div>
                        </div>
                        {groupChannels.length === 0 && !loading
                            ? <div className="cgm-empty" style={{ padding: '20px 16px' }}>{t('failover.emptyGroupHint')}</div>
                            : <SortableList
                                items={groupChannels}
                                getKey={c => c.stream_id}
                                onReorder={handleReorder}
                                renderItem={(ch, _index, handleProps) => (
                                    <>
                                        <span className="drag-handle" {...handleProps}>⋮⋮</span>
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
                                        <button className="remove-btn" onClick={() => handleRemove(ch.stream_id)}>✕</button>
                                    </>
                                )}
                            />
                        }
                    </div>

                    {/* Right Pane: Source/Category Tree Selector */}
                    <div className="source-selector-pane">
                        <div className="search-bar">
                            <input type="text" placeholder={t('failover.searchPlaceholder')} value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)} autoComplete="off" />
                        </div>
                        <div className="selector-content">
                            {loading
                                ? <div className="cgm-empty">{t('failover.loadingTree')}</div>
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
                    <span className="cgm-footer-hint">{t('failover.managerFooterHint')}</span>
                    <button className="close-done-btn" onClick={onClose}>{i18n.t('common:done')}</button>
                </div>

            </div>
        </div>,
        document.body
    );
}
