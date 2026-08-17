/**
 * VerticalSidebar - Vertical navigation sidebar for VOD pages
 *
 * Features:
 * - Fixed width, full height
 * - Vertical scrolling list of categories
 * - Integrated search input at the top
 * - Back button
 */

import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSettingsStore } from '../../stores/settingsStore';
import { useLiveQuery } from '../../hooks/useSqliteLiveQuery';
import { db } from '../../db';
import { useSidebarDragHotkey } from '../../stores/uiStore';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import './VerticalSidebar.css';

// Sortable button for the VOD sidebar — mirrors the LiveTV sidebar's
// SortableSidebarItem pattern: the whole button surface is the drag zone, and
// dragging is only enabled while the configured sidebar drag hotkey is held
// (or always, when the hotkey is set to 'None'). Used for both category items
// and source-group headers.
function SortableVodItem({ id, disabled, className = '', onClick, onContextMenu, dropIndicator = null, children }: {
  id: string;
  disabled?: boolean;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  dropIndicator?: 'above' | 'below' | null;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const style: React.CSSProperties = {
    // Only apply transform while actively dragging — a static transform would
    // create a new CSS containing block that could trap the sticky source headers.
    transform: isDragging ? CSS.Transform.toString(transform) : undefined,
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 99 : undefined,
    touchAction: 'none',
  };
  return (
    <button
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`vod-sortable-item ${className} ${isDragging ? 'dragging' : ''}${dropIndicator ? ` drop-${dropIndicator}` : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {children}
    </button>
  );
}

// Chevron Icon for expand/collapse
const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
    <svg
        width="16" height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease',
            marginRight: '8px'
        }}
    >
        <path d="M9 6l6 6-6 6" />
    </svg>
);

interface Category {
    id: string;
    name: string;
    source_id?: string;
}

export interface VerticalSidebarProps {
    categories: Category[];
    selectedId: string | null; // null = home, 'all' = all, string = category
    onSelect: (id: string | null) => void;
    type?: 'movie' | 'series';
    onBack?: () => void;
    searchQuery?: string;
    onSearchChange?: (query: string) => void;
    onSearchSubmit?: () => void;
    onContextMenu?: (e: React.MouseEvent, sourceId: string, sourceName: string) => void;
}

// Icons
const BackArrow = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
);

const MovieIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12" />
        <path d="M8 4l0 16" />
        <path d="M16 4l0 16" />
        <path d="M4 8l4 0" />
        <path d="M4 16l4 0" />
        <path d="M4 12l16 0" />
        <path d="M16 8l4 0" />
        <path d="M16 16l4 0" />
        <path d="M16 16l4 0" />
    </svg>
);

const SeriesIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -9" />
        <path d="M16 3l-4 4l-4 -4" />
    </svg>
);

const SearchIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
    </svg>
);

const ClearIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 6L6 18M6 6l12 12" />
    </svg>
);

export function VerticalSidebar({
    categories,
    selectedId,
    onSelect,
    type,
    onBack,
    searchQuery = '',
    onSearchChange,
    onSearchSubmit,
    onContextMenu,
}: VerticalSidebarProps) {
    useTranslation();
    const [sources, setSources] = useState<Record<string, string>>({});
    const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
    const [isV3, setIsV3] = useState(false);
    const isFirstLoad = useRef(true);
    const prevSelectedIdRef = useRef(selectedId);

    useEffect(() => {
        setIsV3(document.documentElement.classList.contains('modern-ui-v3'));
    }, []);

    // One-shot per session: collapse all source categories once the
    // (authoritative, hydrated) setting is known — reactive on the setting so
    // the boot race (store still at its hardcoded default while hydration
    // reconciles the real value) can't burn the flag with a stale read.
    const collapseOnStartup = useSettingsStore((s) => s.collapseSourceCategoriesOnStartup);
    useEffect(() => {
        if (collapseOnStartup && isFirstLoad.current) {
            setExpandedSources({});
            isFirstLoad.current = false;
        }
    }, [collapseOnStartup]);

    // Fetch sources to resolve names and initialize expanded state according to user setting
    useEffect(() => {
        async function fetchSources() {
            if (window.storage) {
                const result = await window.storage.getSources();
                if (result.data) {
                    const data = result.data;
                    const sourceMap = data.reduce((acc: Record<string, string>, s: any) => {
                        acc[s.id] = s.name;
                        return acc;
                    }, {});
                    setSources(sourceMap);

                    // Read the value AFTER the await so hydration has had a
                    // chance to land — new sources init per the real setting.
                    const collapseOnStartup = useSettingsStore.getState().collapseSourceCategoriesOnStartup;

                    // Initialize expanded state for sources (collapsed if collapseOnStartup is true)
                    setExpandedSources(prev => {
                        const next = { ...prev };
                        data.forEach((s: any) => {
                            if (next[s.id] === undefined) {
                                next[s.id] = !collapseOnStartup;
                            }
                        });
                        return next;
                    });
                }
            }
        }
        fetchSources();
    }, []);

    // Auto-expand parent source ONLY when user selects a new category (selectedId changes)
    useEffect(() => {
        if (selectedId && selectedId !== prevSelectedIdRef.current && categories.length > 0) {
            const selectedCat = categories.find(c => c.id === selectedId);
            if (selectedCat?.source_id) {
                setExpandedSources(prev => ({
                    ...prev,
                    [selectedCat.source_id!]: true
                }));
            }
        }
        prevSelectedIdRef.current = selectedId;
    }, [selectedId, categories]);

    const toggleSource = (sourceId: string) => {
        setExpandedSources(prev => ({
            ...prev,
            [sourceId]: !prev[sourceId]
        }));
    };

    // Drag-and-drop reordering of categories within a source group, gated on
    // the same configured hotkey as the LiveTV sidebar (Settings > Shortcuts).
    const sidebarDragHotkey = useSidebarDragHotkey();
    const [isDragKeyPressed, setIsDragKeyPressed] = useState(false);

    useEffect(() => {
        if (sidebarDragHotkey === 'None') {
            setIsDragKeyPressed(true);
            return;
        }

        const checkKey = (e: KeyboardEvent) => {
            let active = false;
            if (sidebarDragHotkey === 'Control') active = e.ctrlKey;
            else if (sidebarDragHotkey === 'Alt') active = e.altKey;
            else if (sidebarDragHotkey === 'Shift') active = e.shiftKey;
            else if (sidebarDragHotkey === 'Meta') active = e.metaKey;
            setIsDragKeyPressed(active);
        };

        const handleKeyDown = (e: KeyboardEvent) => checkKey(e);
        const handleKeyUp = (e: KeyboardEvent) => checkKey(e);

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
    }, [sidebarDragHotkey]);

    const isDragActive = sidebarDragHotkey === 'None' || isDragKeyPressed;

    const dndSensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    // Drag-over tracking for the above/below drop indicator lines.
    const [activeDragId, setActiveDragId] = useState<string | null>(null);
    const [overDragId, setOverDragId] = useState<string | null>(null);

    const handleDragStart = (event: DragStartEvent) => {
        setActiveDragId(String(event.active.id));
    };

    const handleDragOver = (event: DragOverEvent) => {
        if (event.over && event.active.id !== event.over.id) {
            setOverDragId(String(event.over.id));
        } else {
            setOverDragId(null);
        }
    };

    const handleDragCancel = () => {
        setActiveDragId(null);
        setOverDragId(null);
    };

    const handleCategoryDragEnd = async (sourceId: string, currentList: Category[], event: DragEndEvent) => {
        const { active, over } = event;
        setActiveDragId(null);
        setOverDragId(null);
        if (!over || active.id === over.id || !currentList) return;

        const oldIndex = currentList.findIndex(c => c.id === active.id);
        const newIndex = currentList.findIndex(c => c.id === over.id);
        if (oldIndex === -1 || newIndex === -1) return;

        const reordered = arrayMove(currentList, oldIndex, newIndex);
        try {
            // Fetch the full rows for this source so we preserve type/enabled/etc.
            // while reassigning display_order for the reordered (visible) items.
            const rows = await db.vodCategories.where('source_id').equals(sourceId).toArray();
            const rowById = new Map(rows.map(r => [r.category_id, r]));
            const updates = reordered
                .map((cat, idx) => {
                    const row = rowById.get(cat.id);
                    return row ? { ...row, display_order: idx } : null;
                })
                .filter((u): u is NonNullable<typeof u> => u !== null);

            if (updates.length > 0) {
                await db.vodCategories.bulkPut(updates);
            }
        } catch (err) {
            console.error('Failed to save VOD category drag order:', err);
        }
    };

    const handleSourceDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveDragId(null);
        setOverDragId(null);
        if (!type || !over || active.id === over.id) return;

        const entries = groupedCategories.entries;
        const oldIndex = entries.findIndex(([id]) => id === active.id);
        const newIndex = entries.findIndex(([id]) => id === over.id);
        if (oldIndex === -1 || newIndex === -1) return;

        const reordered = arrayMove(entries, oldIndex, newIndex);
        const orderedIds = reordered.map(([id]) => id);
        try {
            const pref = await db.prefs.get('vod_sidebar_sources_order');
            let orders: Record<string, string[]> = {};
            if (pref?.value) {
                try {
                    orders = JSON.parse(pref.value);
                } catch {
                    orders = {};
                }
            }
            orders[type] = orderedIds;
            await db.prefs.put({ key: 'vod_sidebar_sources_order', value: JSON.stringify(orders) });
        } catch (err) {
            console.error('Failed to save VOD sidebar source order:', err);
        }
    };

    // One-time drag-reorder hint: shown until dismissed (or auto-hidden after
    // 10s), then persisted forever so it never appears again.
    const dragHintPref = useLiveQuery(
        () => db.prefs.get('vod_drag_hint_dismissed'),
        []
    );
    const dragHintDismissed = dragHintPref?.value === '1';
    const [dragHintVisible, setDragHintVisible] = useState(false);

    useEffect(() => {
        if (!dragHintDismissed) {
            setDragHintVisible(true);
            const timer = setTimeout(() => {
                setDragHintVisible(false);
                db.prefs.put({ key: 'vod_drag_hint_dismissed', value: '1' }).catch(() => {});
            }, 10000);
            return () => clearTimeout(timer);
        }
        setDragHintVisible(false);
    }, [dragHintDismissed]);

    const dismissDragHint = useCallback(() => {
        setDragHintVisible(false);
        db.prefs.put({ key: 'vod_drag_hint_dismissed', value: '1' }).catch(() => {});
    }, []);

    const dragHotkeyLabel = sidebarDragHotkey === 'Control'
        ? 'Ctrl'
        : sidebarDragHotkey === 'Meta'
            ? 'Win'
            : sidebarDragHotkey === 'None'
                ? null
                : sidebarDragHotkey;

    const dragHintLabel = dragHotkeyLabel
        ? i18n.t('vod:dragReorderHint', { hotkey: dragHotkeyLabel })
        : i18n.t('vod:dragReorderHintAlways');

    // Process categories: strip prefixes and preserve database / custom order
    const processedCategories = useMemo(() => {
        return categories
            .map((cat) => ({
                ...cat,
                displayName: cat.name
                    ? cat.name.replace(/^(Series|Movies|Movie)-/i, '').trim()
                    : '', // Handle null/undefined names
            }));
    }, [categories]);

    // Persisted per-type source order (dragged source groups), stored in prefs.
    const sourceOrderPref = useLiveQuery(
        () => db.prefs.get('vod_sidebar_sources_order'),
        []
    );

    const sourceOrder = useMemo(() => {
        if (!type || !sourceOrderPref?.value) return null;
        try {
            const parsed = JSON.parse(sourceOrderPref.value);
            const order = parsed?.[type];
            return Array.isArray(order) ? (order as string[]) : null;
        } catch {
            return null;
        }
    }, [sourceOrderPref, type]);

    // Group categories by source
    const groupedCategories = useMemo(() => {
        const groups: Record<string, typeof processedCategories> = {};
        const orphans: typeof processedCategories = [];

        for (const cat of processedCategories) {
            if (cat.source_id) {
                if (!groups[cat.source_id]) {
                    groups[cat.source_id] = [];
                }
                groups[cat.source_id].push(cat);
            } else {
                orphans.push(cat);
            }
        }

        // Sort groups by source name, then apply the user's persisted drag order
        // (sources in the order list first by index; the rest stay alphabetical).
        const sortedGroupEntries = Object.entries(groups).sort(([aId], [bId]) => {
            const nameA = sources[aId] || '';
            const nameB = sources[bId] || '';
            return nameA.localeCompare(nameB);
        });

        if (sourceOrder && sourceOrder.length > 0) {
            const orderMap = new Map(sourceOrder.map((id, index) => [id, index]));
            sortedGroupEntries.sort(([aId], [bId]) => {
                const orderA = orderMap.has(aId) ? orderMap.get(aId)! : Number.MAX_SAFE_INTEGER;
                const orderB = orderMap.has(bId) ? orderMap.get(bId)! : Number.MAX_SAFE_INTEGER;
                if (orderA !== orderB) return orderA - orderB;
                return (sources[aId] || '').localeCompare(sources[bId] || '');
            });
        }

        return { entries: sortedGroupEntries, orphans };
    }, [processedCategories, sources, sourceOrder]);

    const showDragHint = dragHintVisible && (groupedCategories.entries.length > 0 || groupedCategories.orphans.length > 0);

    // Handle search key down
    const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            onSearchSubmit?.();
        }
    }, [onSearchSubmit]);

    return (
        <div className="vertical-sidebar">
            {/* Header: Back Button & Title */}
            {!isV3 && (
                <div className="vertical-sidebar__header">
                    {onBack && (
                        <button
                            className="vertical-sidebar__back"
                            onClick={onBack}
                            aria-label={i18n.t('vod:goBack')}
                        >
                            <span className="vertical-sidebar__back-arrow">
                                <BackArrow />
                            </span>
                            <span className="vertical-sidebar__back-text">{i18n.t('vod:back')}</span>
                            <span className="vertical-sidebar__back-icon">
                                {type === 'series' ? <SeriesIcon /> : <MovieIcon />}
                            </span>
                        </button>
                    )}
                </div>
            )}

            {/* Search Bar */}
            {onSearchChange && (
                <div className="vertical-sidebar__search-container">
                    <div className="vertical-sidebar__search">
                        <SearchIcon />
                        <input
                            type="text"
                            placeholder={type === 'series' ? i18n.t('vod:searchSeries') : i18n.t('vod:searchMovies')}
                            value={searchQuery}
                            onChange={(e) => onSearchChange(e.target.value)}
                            onKeyDown={handleSearchKeyDown}
                        />
                        {searchQuery && (
                            <button
                                className="vertical-sidebar__search-clear"
                                onClick={() => onSearchChange('')}
                                aria-label={i18n.t('vod:clearSearch')}
                            >
                                <ClearIcon />
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Fixed Top Section: Home, All, Recent */}
            <div className="vertical-sidebar__top">
                {isV3 ? (
                    <>
                        {/* Home Link */}
                        <button
                            className={`vertical-sidebar__item category-list-bar ${selectedId === null ? 'active' : ''}`}
                            onClick={() => onSelect(null)}
                        >
                            <div className="category-item-left">
                                <span className="category-icon watchlist-icon">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                                        <polyline points="9 22 9 12 15 12 15 22" />
                                    </svg>
                                </span>
                                <span className="category-name">{i18n.t('vod:home')}</span>
                            </div>
                        </button>

                        {/* All Link */}
                        <button
                            className={`vertical-sidebar__item category-list-bar ${selectedId === 'all' ? 'active' : ''}`}
                            onClick={() => onSelect('all')}
                        >
                            <div className="category-item-left">
                                <span className="category-icon all-channels-icon">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                                        <polyline points="17 2 12 7 7 2" />
                                    </svg>
                                </span>
                                <span className="category-name">{type === 'series' ? i18n.t('vod:allSeries') : i18n.t('vod:allMovies')}</span>
                            </div>
                        </button>

                        {/* Favorites Link */}
                        <button
                            className={`vertical-sidebar__item category-list-bar ${selectedId === 'favorites' ? 'active' : ''}`}
                            onClick={() => onSelect('favorites')}
                        >
                            <div className="category-item-left">
                                <span className="category-icon favorites-icon">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                                    </svg>
                                </span>
                                <span className="category-name">{i18n.t('vod:favorites')}</span>
                            </div>
                        </button>

                        {/* Playlists Link */}
                        <button
                            className={`vertical-sidebar__item category-list-bar ${selectedId === 'playlists' ? 'active' : ''}`}
                            onClick={() => onSelect('playlists')}
                        >
                            <div className="category-item-left">
                                <span className="category-icon playlist-icon">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <line x1="8" y1="6" x2="21" y2="6" />
                                        <line x1="8" y1="12" x2="21" y2="12" />
                                        <line x1="8" y1="18" x2="21" y2="18" />
                                        <line x1="3" y1="6" x2="3.01" y2="6" />
                                        <line x1="3" y1="12" x2="3.01" y2="12" />
                                        <line x1="3" y1="18" x2="3.01" y2="18" />
                                    </svg>
                                </span>
                                <span className="category-name">{i18n.t('vod:playlists')}</span>
                            </div>
                        </button>

                        {/* Local Link */}
                        <button
                            className={`vertical-sidebar__item category-list-bar ${selectedId === 'local' ? 'active' : ''}`}
                            onClick={() => onSelect('local')}
                        >
                            <div className="category-item-left">
                                <span className="category-icon local-icon">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                    </svg>
                                </span>
                                <span className="category-name">{i18n.t('vod:local')}</span>
                            </div>
                        </button>

                        {/* Recent Link */}
                        <button
                            className={`vertical-sidebar__item category-list-bar ${selectedId === 'recent' ? 'active' : ''}`}
                            onClick={() => onSelect('recent')}
                        >
                            <div className="category-item-left">
                                <span className="category-icon recent-icon">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="10" />
                                        <polyline points="12 6 12 12 16 14" />
                                    </svg>
                                </span>
                                <span className="category-name">{i18n.t('vod:recent')}</span>
                            </div>
                        </button>
                    </>
                ) : (
                    <>
                        {/* Home Link */}
                        <button
                            className={`vertical-sidebar__item ${selectedId === null ? 'active' : ''}`}
                            onClick={() => onSelect(null)}
                        >
                            {i18n.t('vod:home')}
                        </button>

                        {/* All Link */}
                        <button
                            className={`vertical-sidebar__item ${selectedId === 'all' ? 'active' : ''}`}
                            onClick={() => onSelect('all')}
                        >
                            {type === 'series' ? i18n.t('vod:allSeries') : i18n.t('vod:allMovies')}
                        </button>

                        {/* Favorites Link */}
                        <button
                            className={`vertical-sidebar__item ${selectedId === 'favorites' ? 'active' : ''}`}
                            onClick={() => onSelect('favorites')}
                        >
                            {i18n.t('vod:favorites')}
                        </button>

                        {/* Playlists Link */}
                        <button
                            className={`vertical-sidebar__item ${selectedId === 'playlists' ? 'active' : ''}`}
                            onClick={() => onSelect('playlists')}
                        >
                            {i18n.t('vod:playlists')}
                        </button>

                        {/* Local Link */}
                        <button
                            className={`vertical-sidebar__item ${selectedId === 'local' ? 'active' : ''}`}
                            onClick={() => onSelect('local')}
                        >
                            {i18n.t('vod:local')}
                        </button>

                        {/* Recent Link */}
                        <button
                            className={`vertical-sidebar__item ${selectedId === 'recent' ? 'active' : ''}`}
                            onClick={() => onSelect('recent')}
                        >
                            {i18n.t('vod:recent')}
                        </button>
                    </>
                )}
            </div>

            {/* Scrollable Bottom Section: Source Groups */}
            <div className={`vertical-sidebar__scrollable ${isDragActive ? 'vod-drag-active' : ''}`}>
                {/* Sources (reorderable with the drag hotkey) each containing their categories */}
                <DndContext
                    sensors={dndSensors}
                    collisionDetection={closestCenter}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragCancel={handleDragCancel}
                    onDragEnd={handleSourceDragEnd}
                >
                    <SortableContext items={groupedCategories.entries.map(([id]) => id)} strategy={verticalListSortingStrategy}>
                        {groupedCategories.entries.map(([sourceId, sourceCats]) => {
                            const isExpanded = !!expandedSources[sourceId] || searchQuery.trim().length > 0;
                            const activeIdx = activeDragId ? groupedCategories.entries.findIndex(([id]) => id === activeDragId) : -1;
                            const overIdx = overDragId ? groupedCategories.entries.findIndex(([id]) => id === overDragId) : -1;
                            const sourceDropIndicator = overDragId === sourceId && activeDragId !== overDragId
                                ? (activeIdx < overIdx ? 'below' : 'above')
                                : null;
                            return (
                                <div key={sourceId} className={`vertical-sidebar__source-group ${isExpanded ? 'is-expanded' : ''}`}>
                                    <SortableVodItem
                                        id={sourceId}
                                        disabled={!isDragActive}
                                        className="vertical-sidebar__source-header"
                                        onClick={() => toggleSource(sourceId)}
                                        onContextMenu={(e) => {
                                            e.preventDefault();
                                            onContextMenu?.(e, sourceId, sources[sourceId] || i18n.t('vod:unknownSource'));
                                        }}
                                        dropIndicator={sourceDropIndicator}
                                    >
                                        <div className="source-header-left">
                                            <ChevronIcon expanded={isExpanded} />
                                            <span className="source-name">{sources[sourceId] || i18n.t('vod:loadingSource')}</span>
                                        </div>
                                        <span className="source-count">{sourceCats.length}</span>
                                    </SortableVodItem>

                                    {isExpanded && (
                                        <div className="vertical-sidebar__source-content">
                                            <DndContext
                                                sensors={dndSensors}
                                                collisionDetection={closestCenter}
                                                onDragStart={handleDragStart}
                                                onDragOver={handleDragOver}
                                                onDragCancel={handleDragCancel}
                                                onDragEnd={(e) => handleCategoryDragEnd(sourceId, sourceCats, e)}
                                            >
                                                <SortableContext items={sourceCats.map(c => c.id)} strategy={verticalListSortingStrategy}>
                                                    {sourceCats.map((cat) => {
                                                        const catActiveIdx = activeDragId ? sourceCats.findIndex(c => c.id === activeDragId) : -1;
                                                        const catOverIdx = overDragId ? sourceCats.findIndex(c => c.id === overDragId) : -1;
                                                        const dropIndicator = overDragId === cat.id && activeDragId !== overDragId
                                                            ? (catActiveIdx < catOverIdx ? 'below' : 'above')
                                                            : null;
                                                        return (
                                                            <SortableVodItem
                                                                key={cat.id}
                                                                id={cat.id}
                                                                disabled={!isDragActive}
                                                                className={`vertical-sidebar__item nested ${selectedId === cat.id ? 'active' : ''}`}
                                                                onClick={() => onSelect(cat.id)}
                                                                dropIndicator={dropIndicator}
                                                            >
                                                                {cat.displayName}
                                                            </SortableVodItem>
                                                        );
                                                    })}
                                                </SortableContext>
                                            </DndContext>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </SortableContext>
                </DndContext>

                {/* Orphan Categories (if any) */}
                {groupedCategories.orphans.map((cat) => (
                    <button
                        key={cat.id}
                        className={`vertical-sidebar__item ${selectedId === cat.id ? 'active' : ''}`}
                        onClick={() => onSelect(cat.id)}
                    >
                        {cat.displayName}
                    </button>
                ))}
            </div>

            {/* One-time drag-reorder hint */}
            {showDragHint && (
                <div className="vertical-sidebar__drag-hint">
                    <span className="vertical-sidebar__drag-hint-text">
                        {dragHintLabel}
                    </span>
                    <button
                        className="vertical-sidebar__drag-hint-close"
                        onClick={dismissDragHint}
                        aria-label={i18n.t('vod:dismissDragHint')}
                    >
                        ✕
                    </button>
                </div>
            )}
        </div>
    );
}

export default VerticalSidebar;
