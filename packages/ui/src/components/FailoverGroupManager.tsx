import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { db, type StoredChannel, type StoredCategory } from '../db';
import { buildSearchQueryClauses } from '../utils/searchNormalization';
import { useSettingsStore, DEFAULT_MAX_SEARCH_RESULTS } from '../stores/settingsStore';
import {
    addChannelToFailoverGroup,
    removeChannelFromFailoverGroup,
    moveChannelToFailoverGroup,
    reorderFailoverGroupChannels,
    renameFailoverGroup,
    getFailoverGroupMembers,
} from '../services/failover-groups';
import {
    findFailoverCandidatesForChannel,
    type FailoverCandidate,
} from '../services/failoverMatcher';
import './CustomGroupManager.css'; // Reuse the same styles
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
    useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface FailoverGroupManagerProps {
    groupId: string;
    groupName: string;
    onClose: () => void;
}

type GroupChannel = StoredChannel & { priority: number };

interface ConflictInfo {
    streamId: string;
    channelName: string;
    existingGroupId: string;
    existingGroupName: string;
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

/* ── SVG Icons ── */
function TvSvg({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6, flexShrink: 0 }}>
            <rect width="20" height="15" x="2" y="7" rx="2" ry="2" />
            <polyline points="17 2 12 7 7 2" />
        </svg>
    );
}

function CheckSvg({ size = 12 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}

function CrossSvg({ size = 12 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    );
}

// ── Sortable Failover Channel Item with Full-Surface Card Dragging ────────────

function SortableFailoverChannelItem({
    ch,
    displaySource,
    getChannelSourceCategory,
    handleRemove,
}: {
    ch: GroupChannel;
    displaySource: boolean;
    getChannelSourceCategory: (ch: GroupChannel) => string;
    handleRemove: (streamId: string) => void;
}) {
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
            className={`group-channel-item${isDragging ? ' dragging' : ''}`}
        >
            {ch.stream_icon ? (
                <img src={ch.stream_icon} className="cgm-ch-logo" alt="" />
            ) : (
                <span className="cgm-ch-logo-placeholder"><TvSvg size={16} /></span>
            )}
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
                title={i18n.t('common:remove', { defaultValue: 'Remove' })}
            >
                <CrossSvg size={12} />
            </button>
        </div>
    );
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
                const maxSearchResults = useSettingsStore.getState().maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;

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
                        <span>{sourceNameMap.get(sourceId) || t('failover.unknownSource', { defaultValue: 'Unknown Source' })}</span>
                        <span className="cgm-count">{channels.length}</span>
                    </div>
                    <div className="node-children">
                        {channels.map(ch => {
                            const inGroup = groupChannelIds.has(ch.stream_id);
                            return (
                                <div key={ch.stream_id} className={`channel-node${inGroup ? ' in-group' : ''}`}
                                    onClick={() => inGroup ? onRemove(ch.stream_id) : onAdd(ch)}>
                                    <span className="cgm-check">{inGroup ? '✓' : '+'}</span>
                                    {ch.stream_icon ? (
                                        <img src={ch.stream_icon} className="channel-node-logo" alt="" />
                                    ) : (
                                        <TvSvg size={13} />
                                    )}
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

function TreeView({
    sourcesAndCategories,
    searchQuery,
    expandedNodes,
    toggleNode,
    groupChannelIds,
    onAdd,
    onRemove,
    enabledSourceIdsKey,
    enabledSourceIds,
}: TreeViewProps) {
    const { t } = useTranslation('settings');
    const [loadedChannels, setLoadedChannels] = useState<StoredChannel[]>([]);
    const [loadingNode, setLoadingNode] = useState<string | null>(null);
    const loadedCats = useRef<Set<string>>(new Set());

    const loadCategoryChannels = useCallback(async (categoryId: string, sourceId: string) => {
        if (loadedCats.current.has(categoryId)) return;
        loadedCats.current.add(categoryId);
        setLoadingNode(categoryId);
        try {
            const rawChannels = await db.channels.where('source_id').equals(sourceId).toArray();
            const matching = rawChannels.filter(c => {
                if (c.enabled === false) return false;
                const catIds = parseCategoryIds(c.category_ids);
                return catIds.includes(String(categoryId));
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
                                                                {ch.stream_icon ? (
                                                                    <img src={ch.stream_icon} className="channel-node-logo" alt="" />
                                                                ) : (
                                                                    <TvSvg size={13} />
                                                                )}
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

// ── Main FailoverGroupManager ─────────────────────────────────────────────────

export function FailoverGroupManager({ groupId, groupName, onClose }: FailoverGroupManagerProps) {
    const { t } = useTranslation('settings');
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
    const [groupChannels, setGroupChannels] = useState<GroupChannel[]>([]);
    const [sourcesAndCategories, setSourcesAndCategories] = useState<{ sources: any[]; categories: StoredCategory[]; enabledSourceIds: Set<string> } | undefined>();
    const [loading, setLoading] = useState(true);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [conflictError, setConflictError] = useState<ConflictInfo | null>(null);
    const [suggestions, setSuggestions] = useState<FailoverCandidate[]>([]);
    const [loadingSuggestions, setLoadingSuggestions] = useState(false);

    // @dnd-kit sensors with 5px threshold
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

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

    // Load backup suggestions whenever group channels change
    useEffect(() => {
        if (groupChannels.length === 0) {
            setSuggestions([]);
            return;
        }

        let isMounted = true;
        setLoadingSuggestions(true);

        const primaryChannel = groupChannels[0];
        findFailoverCandidatesForChannel(primaryChannel)
            .then((candidates) => {
                if (isMounted) {
                    const unlinked = candidates.filter((c) => !groupChannelIds.has(c.channel.stream_id));
                    setSuggestions(unlinked);
                }
            })
            .catch((e) => {
                console.error('[FailoverGroupManager] Failed to load suggestions:', e);
            })
            .finally(() => {
                if (isMounted) setLoadingSuggestions(false);
            });

        return () => {
            isMounted = false;
        };
    }, [groupChannels[0]?.stream_id, groupChannels.length]);

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
        setConflictError(null);
        try {
            await addChannelToFailoverGroup(groupId, ch.stream_id);
            setGroupChannels(prev => [...prev, { ...ch, priority: prev.length }]);
        } catch (e: any) {
            console.error('Failed to add:', e);
            if (e.code === 'ALREADY_IN_GROUP' && e.existingGroupId) {
                setConflictError({
                    streamId: ch.stream_id,
                    channelName: ch.alias || ch.name,
                    existingGroupId: e.existingGroupId,
                    existingGroupName: e.existingGroupName || e.existingGroupId,
                });
            } else {
                setErrorMsg(e.message || t('failover.failedAdd'));
            }
        }
    }, [groupId, groupChannelIds, t]);

    const handleMoveChannelHere = async () => {
        if (!conflictError) return;
        const { streamId } = conflictError;
        setErrorMsg(null);
        setConflictError(null);
        try {
            await moveChannelToFailoverGroup(groupId, streamId);
            const ch = await db.channels.where('stream_id').equals(streamId).first();
            if (ch) {
                setGroupChannels(prev => [...prev.filter(c => c.stream_id !== streamId), { ...ch, priority: prev.length }]);
            }
        } catch (err: any) {
            console.error('Failed to move channel:', err);
            setErrorMsg(err.message || t('failover.failedMoveChannel', { defaultValue: 'Failed to move channel to this group.' }));
        }
    };

    const handleRemove = useCallback(async (streamId: string) => {
        setGroupChannels(prev => prev.filter(c => c.stream_id !== streamId));
        try {
            await removeChannelFromFailoverGroup(streamId);
        } catch (e) {
            console.error('Failed to remove:', e);
        }
    }, []);

    // @dnd-kit DragEnd handler
    const handleDragEnd = useCallback(async (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;

        const oldIndex = groupChannels.findIndex((c) => c.stream_id === active.id);
        const newIndex = groupChannels.findIndex((c) => c.stream_id === over.id);
        if (oldIndex === -1 || newIndex === -1) return;

        const newItems = arrayMove(groupChannels, oldIndex, newIndex).map((c, idx) => ({
            ...c,
            priority: idx,
        }));
        setGroupChannels(newItems);
        try {
            await reorderFailoverGroupChannels(groupId, newItems.map((c) => c.stream_id));
        } catch (e) {
            console.error('Failed to reorder failover channels:', e);
        }
    }, [groupChannels, groupId]);

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
                            <button className="cgm-rename-ok" onClick={commitRename}><CheckSvg size={14} /></button>
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
                    <button className="close-btn" onClick={onClose} title={i18n.t('common:close')}><CrossSvg size={14} /></button>
                </div>

                {/* Conflict Error Banner with Instant "Move Here" Action */}
                {conflictError && (
                    <div style={{
                        padding: '10px 24px',
                        background: 'rgba(255, 92, 92, 0.15)',
                        borderBottom: '1px solid rgba(255, 92, 92, 0.3)',
                        color: '#ff8a8a',
                        fontSize: '0.86rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '14px',
                        flexWrap: 'wrap',
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: '#ff5c5c' }}>
                                <circle cx="12" cy="12" r="10" />
                                <line x1="12" y1="8" x2="12" y2="12" />
                                <line x1="12" y1="16" x2="12.01" y2="16" />
                            </svg>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {t('failover.conflictInGroup', {
                                    defaultValue: 'Channel "{{channel}}" is already in failover group "{{group}}".',
                                    channel: conflictError.channelName,
                                    group: conflictError.existingGroupName,
                                })}
                            </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                            <button
                                onClick={handleMoveChannelHere}
                                style={{
                                    background: 'var(--accent-primary, #00d4ff)',
                                    color: '#000',
                                    border: 'none',
                                    borderRadius: '6px',
                                    padding: '5px 12px',
                                    fontWeight: 600,
                                    fontSize: '0.8rem',
                                    cursor: 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '5px',
                                    boxShadow: '0 2px 8px rgba(0, 212, 255, 0.3)',
                                    transition: 'opacity 0.15s ease',
                                }}
                            >
                                <span>{t('failover.moveHere', { defaultValue: 'Remove from "{{group}}" & Add Here', group: conflictError.existingGroupName })}</span>
                            </button>
                            <button
                                onClick={() => setConflictError(null)}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    color: 'rgba(255, 255, 255, 0.6)',
                                    cursor: 'pointer',
                                    padding: '4px 6px',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                }}
                                title={i18n.t('common:dismiss', { defaultValue: 'Dismiss' })}
                            >
                                <CrossSvg size={13} />
                            </button>
                        </div>
                    </div>
                )}

                {errorMsg && !conflictError && (
                    <div style={{
                        padding: '8px 24px',
                        background: 'rgba(255, 92, 92, 0.15)',
                        borderBottom: '1px solid rgba(255, 92, 92, 0.3)',
                        color: '#ff5c5c',
                        fontSize: '0.85rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                    }}>
                        <span>{errorMsg}</span>
                        <button
                            onClick={() => setErrorMsg(null)}
                            style={{
                                background: 'none',
                                border: 'none',
                                color: 'rgba(255, 255, 255, 0.6)',
                                cursor: 'pointer',
                                padding: '4px 6px',
                                display: 'inline-flex',
                                alignItems: 'center',
                            }}
                        >
                            <CrossSvg size={13} />
                        </button>
                    </div>
                )}

                <div className="custom-group-content">

                    {/* Left Pane: Group Channels with @dnd-kit full-surface card drag */}
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
                        {groupChannels.length === 0 && !loading ? (
                            <div className="cgm-empty" style={{ padding: '20px 16px' }}>{t('failover.emptyGroupHint')}</div>
                        ) : (
                            <DndContext
                                sensors={sensors}
                                collisionDetection={closestCenter}
                                onDragEnd={handleDragEnd}
                            >
                                <SortableContext
                                    items={groupChannels.map((ch) => ch.stream_id)}
                                    strategy={verticalListSortingStrategy}
                                >
                                    <div className="channel-list-container">
                                        {groupChannels.map((ch) => (
                                            <SortableFailoverChannelItem
                                                key={ch.stream_id}
                                                ch={ch}
                                                displaySource={displaySource}
                                                getChannelSourceCategory={getChannelSourceCategory}
                                                handleRemove={handleRemove}
                                            />
                                        ))}
                                    </div>
                                </SortableContext>
                            </DndContext>
                        )}
                    </div>

                    {/* Right Pane: Source/Category Tree Selector */}
                    <div className="source-selector-pane">
                        <div className="search-bar">
                            <input type="text" placeholder={t('failover.searchPlaceholder')} value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)} autoComplete="off" />
                        </div>
                        <div className="selector-content">
                            {/* Suggested Backup Streams */}
                            {!searchQuery && suggestions.length > 0 && (
                                <div style={{
                                    margin: '8px 12px 14px 12px',
                                    background: 'rgba(0, 212, 255, 0.05)',
                                    border: '1px solid rgba(0, 212, 255, 0.2)',
                                    borderRadius: '8px',
                                    padding: '10px 12px',
                                }}>
                                    <div style={{
                                        fontSize: '0.82rem',
                                        fontWeight: 600,
                                        color: 'var(--accent-primary, #00d4ff)',
                                        marginBottom: '8px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                    }}>
                                        <span>{t('failover.suggestedBackups', { defaultValue: 'Suggested Backup Streams' })}</span>
                                        {loadingSuggestions && <span style={{ fontSize: '0.72rem', opacity: 0.7 }}>{t('failover.checking', { defaultValue: 'Checking...' })}</span>}
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                        {suggestions.map((cand) => {
                                            const sourceName = sourceNameMap.get(String(cand.channel.source_id));
                                            return (
                                                <div
                                                    key={cand.channel.stream_id}
                                                    style={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'space-between',
                                                        padding: '6px 10px',
                                                        background: 'rgba(255, 255, 255, 0.04)',
                                                        borderRadius: '6px',
                                                    }}
                                                >
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                                                        {cand.channel.stream_icon ? (
                                                            <img src={cand.channel.stream_icon} style={{ width: '20px', height: '20px', objectFit: 'contain' }} alt="" />
                                                        ) : (
                                                            <TvSvg size={14} />
                                                        )}
                                                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                                                            <span style={{ fontSize: '0.82rem', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                                {cand.channel.alias || cand.channel.name}
                                                            </span>
                                                            <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)' }}>
                                                                {sourceName || cand.channel.source_id} • {cand.reason}
                                                            </span>
                                                        </div>
                                                    </div>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                                                        <span style={{
                                                            fontSize: '0.7rem',
                                                            fontWeight: 600,
                                                            padding: '2px 6px',
                                                            borderRadius: '10px',
                                                            background: 'rgba(76, 175, 80, 0.2)',
                                                            color: '#81c784',
                                                        }}>
                                                            {Math.round(cand.score * 100)}%
                                                        </span>
                                                        <button
                                                            onClick={() => handleAdd(cand.channel)}
                                                            style={{
                                                                padding: '4px 10px',
                                                                borderRadius: '4px',
                                                                border: 'none',
                                                                background: 'var(--accent-primary, #00d4ff)',
                                                                color: '#000',
                                                                fontWeight: 600,
                                                                fontSize: '0.75rem',
                                                                cursor: 'pointer',
                                                            }}
                                                        >
                                                            + {t('failover.add', { defaultValue: 'Add' })}
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

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
