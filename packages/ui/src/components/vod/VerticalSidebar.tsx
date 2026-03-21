/**
 * VerticalSidebar - Vertical navigation sidebar for VOD pages
 *
 * Features:
 * - Fixed width, full height
 * - Vertical scrolling list of categories
 * - Integrated search input at the top
 * - Back button
 */

import { useMemo, useCallback, useState, useEffect } from 'react';
import './VerticalSidebar.css';

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
    const [sources, setSources] = useState<Record<string, string>>({});
    const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});

    // Fetch sources to resolve names and initialize expanded state
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

                    // Initialize expanded state for sources
                    setExpandedSources(prev => {
                        const next = { ...prev };
                        data.forEach((s: any) => {
                            if (next[s.id] === undefined) {
                                next[s.id] = true; // default expanded
                            }
                        });
                        return next;
                    });
                }
            }
        }
        fetchSources();
    }, []);

    const toggleSource = (sourceId: string) => {
        setExpandedSources(prev => ({
            ...prev,
            [sourceId]: !prev[sourceId]
        }));
    };

    // Process categories: strip prefixes and sort alphabetically
    const processedCategories = useMemo(() => {
        return categories
            .map((cat) => ({
                ...cat,
                displayName: cat.name
                    ? cat.name.replace(/^(Series|Movies|Movie)-/i, '').trim()
                    : '', // Handle null/undefined names
            }))
            .sort((a, b) => a.displayName.localeCompare(b.displayName));
    }, [categories]);

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

        // Sort groups by source name
        const sortedGroupEntries = Object.entries(groups).sort(([aId], [bId]) => {
            const nameA = sources[aId] || '';
            const nameB = sources[bId] || '';
            return nameA.localeCompare(nameB);
        });

        return { entries: sortedGroupEntries, orphans };
    }, [processedCategories, sources]);

    // Handle search key down
    const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            onSearchSubmit?.();
        }
    }, [onSearchSubmit]);

    return (
        <div className="vertical-sidebar">
            {/* Header: Back Button & Title */}
            <div className="vertical-sidebar__header">
                {onBack && (
                    <button
                        className="vertical-sidebar__back"
                        onClick={onBack}
                        aria-label="Go back"
                    >
                        <span className="vertical-sidebar__back-arrow">
                            <BackArrow />
                        </span>
                        <span className="vertical-sidebar__back-text">Back</span>
                        <span className="vertical-sidebar__back-icon">
                            {type === 'series' ? <SeriesIcon /> : <MovieIcon />}
                        </span>
                    </button>
                )}
            </div>

            {/* Search Bar */}
            {onSearchChange && (
                <div className="vertical-sidebar__search-container">
                    <div className="vertical-sidebar__search">
                        <SearchIcon />
                        <input
                            type="text"
                            placeholder={type === 'series' ? 'Search series...' : 'Search movies...'}
                            value={searchQuery}
                            onChange={(e) => onSearchChange(e.target.value)}
                            onKeyDown={handleSearchKeyDown}
                        />
                        {searchQuery && (
                            <button
                                className="vertical-sidebar__search-clear"
                                onClick={() => onSearchChange('')}
                                aria-label="Clear search"
                            >
                                <ClearIcon />
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Navigation Links */}
            <nav className="vertical-sidebar__nav">
                {/* Home Link */}
                <button
                    className={`vertical-sidebar__item ${selectedId === null ? 'active' : ''}`}
                    onClick={() => onSelect(null)}
                >
                    Home
                </button>

                {/* All Link */}
                <button
                    className={`vertical-sidebar__item ${selectedId === 'all' ? 'active' : ''}`}
                    onClick={() => onSelect('all')}
                >
                    All {type === 'series' ? 'Series' : 'Movies'}
                </button>

                <div className="vertical-sidebar__separator" />

                {/* Categories grouped by Source */}
                {groupedCategories.entries.map(([sourceId, sourceCats]) => (
                    <div key={sourceId} className="vertical-sidebar__source-group">
                        <button
                            className="vertical-sidebar__source-header"
                            onClick={() => toggleSource(sourceId)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                onContextMenu?.(e, sourceId, sources[sourceId] || 'Unknown Source');
                            }}
                        >
                            <div className="source-header-left">
                                <ChevronIcon expanded={!!expandedSources[sourceId]} />
                                <span className="source-name">{sources[sourceId] || 'Loading...'}</span>
                            </div>
                            <span className="source-count">{sourceCats.length}</span>
                        </button>

                        {expandedSources[sourceId] && (
                            <div className="vertical-sidebar__source-content">
                                {sourceCats.map((cat) => (
                                    <button
                                        key={cat.id}
                                        className={`vertical-sidebar__item nested ${selectedId === cat.id ? 'active' : ''}`}
                                        onClick={() => onSelect(cat.id)}
                                    >
                                        {cat.displayName}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                ))}

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
            </nav>
        </div>
    );
}

export default VerticalSidebar;
