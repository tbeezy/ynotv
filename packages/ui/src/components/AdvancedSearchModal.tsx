import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import i18n from '../i18n';
import { db, type StoredCategory, type CategoryFolder } from '../db';
import { isCategorySortCustomized } from '../utils/categorySortOverrides';
import { useSettingsStore } from '../stores/settingsStore';
import './AdvancedSearchModal.css';

export type SearchScope = 'channels' | 'epg' | 'both';

export interface AdvancedSearchConfig {
  query: string;
  scope: SearchScope;
  sourceIds: string[];
  categoryIds: string[];
  useForRegular: boolean;
}

interface SourceInfo {
  id: string;
  name: string;
  enabled: boolean;
}

interface AdvancedSearchModalProps {
  isOpen: boolean;
  initialConfig?: AdvancedSearchConfig;
  onSearch: (config: AdvancedSearchConfig) => void;
  onClose: () => void;
}

export function AdvancedSearchModal({ isOpen, initialConfig, onSearch, onClose }: AdvancedSearchModalProps) {
  const [query, setQuery] = useState(initialConfig?.query ?? '');
  const [scope, setScope] = useState<SearchScope>(initialConfig?.scope ?? 'both');
  const [useForRegular, setUseForRegular] = useState(initialConfig?.useForRegular ?? false);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [categories, setCategories] = useState<StoredCategory[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set(initialConfig?.sourceIds ?? []));
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<string>>(new Set(initialConfig?.categoryIds ?? []));
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  const [categoryFolders, setCategoryFolders] = useState<CategoryFolder[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  // Load enabled sources and categories on open
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    setLoading(true);

    async function loadData() {
      try {
        const dbInstance = await (db as any).dbPromise;

        // Load sources from storage
        const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
        const enabledSources: SourceInfo[] = (sourcesResult.data || [])
          .filter((s: any) => s.enabled !== false)
          .map((s: any) => ({ id: s.id, name: s.name, enabled: true }));

        // Also load custom playlists from db.customPlaylists
        const customPlaylists = await db.customPlaylists.toArray();
        for (const pl of customPlaylists) {
          enabledSources.push({ id: `playlist:${pl.playlist_id}`, name: pl.name, enabled: true });
        }

        // Sort sources according to sidebar_sources_order if it exists (matching LiveTV Sidebar)
        try {
          const sidebarOrderPref = await db.prefs.get('sidebar_sources_order');
          if (sidebarOrderPref?.value) {
            const sidebarSourcesOrder = JSON.parse(sidebarOrderPref.value) as string[];
            const orderMap = new Map(sidebarSourcesOrder.map((id, index) => [id, index]));
            enabledSources.sort((a, b) => {
              const orderA = orderMap.has(a.id) ? orderMap.get(a.id)! : Number.MAX_SAFE_INTEGER;
              const orderB = orderMap.has(b.id) ? orderMap.get(b.id)! : Number.MAX_SAFE_INTEGER;
              if (orderA !== orderB) return orderA - orderB;
              return a.name.localeCompare(b.name);
            });
          }
        } catch (e) {
          console.warn('[AdvancedSearchModal] Failed to parse sidebar sources order:', e);
        }

        // Load raw category channel counts
        const nativeCounts: Record<string, number> = {};
        const manualCounts: Record<string, number> = {};

        try {
          const nativeRows = await dbInstance.select(
            `SELECT c.source_id, cat.value as cat_id, COUNT(*) as cnt
             FROM channels c, json_each(c.category_ids) AS cat
             WHERE (c.enabled IS NULL OR c.enabled NOT IN (0, '0', 'false'))
             GROUP BY c.source_id, cat.value`
          );
          for (const row of nativeRows) {
            nativeCounts[`${row.source_id}:${row.cat_id}`] = row.cnt;
          }
        } catch (e) {
          console.warn('[AdvancedSearchModal] Failed to fetch native channel counts:', e);
        }

        try {
          const manualRows = await dbInstance.select(
            `SELECT playlist_id, parent_category_id, COUNT(*) as cnt
             FROM playlist_individual_channels
             WHERE parent_category_id IS NOT NULL
             GROUP BY playlist_id, parent_category_id`
          );
          for (const row of manualRows) {
            manualCounts[`${row.playlist_id}:${row.parent_category_id}`] = row.cnt;
          }
        } catch (e) {
          console.warn('[AdvancedSearchModal] Failed to fetch manual channel counts:', e);
        }

        // Load DB categories and playlist category links
        const allCategories = await db.categories.toArray();
        const nativeCategoryMap = new Map<string, StoredCategory>();
        for (const cat of allCategories) {
          nativeCategoryMap.set(cat.category_id, cat);
        }

        const allCategoryLinks = await db.playlistCategoryLinks.toArray();
        const allCategoryFolders = await db.categoryFolders.toArray();

        // categorySortOrder is a settings-store field — read it synchronously
        // instead of paying an IPC getSettings round-trip.
        const categorySortOrder: 'default' | 'alphabetical' = useSettingsStore.getState().categorySortOrder || 'default';

        // Load pinned categories
        let pinnedCategories: string[] = [];
        try {
          const savedPinned = localStorage.getItem('ynotv:pinnedCategories');
          if (savedPinned) {
            pinnedCategories = JSON.parse(savedPinned);
          }
        } catch (e) {
          console.warn('[AdvancedSearchModal] Failed to load pinnedCategories:', e);
        }

        // Build active category list for each source / playlist
        const activeCategories: StoredCategory[] = [];

        for (const source of enabledSources) {
          const isCustomPlaylist = source.id.startsWith('playlist:');
          const targetPlaylistId = isCustomPlaylist
            ? source.id.replace('playlist:', '')
            : source.id;

          const links = allCategoryLinks
            .filter(l => l.playlist_id === targetPlaylistId);

          const sourceCats: (StoredCategory & { display_order?: number })[] = [];

          if (!isCustomPlaylist) {
            // Native categories for real source
            const nativeCats = allCategories
              .filter(c => c.source_id === source.id && c.enabled !== false);

            for (const cat of nativeCats) {
              const displayName = cat.alias || cat.category_name;
              const nativeCnt = nativeCounts[`${source.id}:${cat.category_id}`] || 0;
              const manualCatCnt = manualCounts[`${source.id}:${cat.category_id}`] || 0;

              sourceCats.push({
                category_id: cat.category_id,
                category_name: displayName,
                source_id: source.id,
                channel_count: nativeCnt + manualCatCnt,
                enabled: cat.enabled !== false,
                display_order: cat.display_order ?? 0,
                folder_id: (cat as any).folder_id || null,
              } as any);
            }
          }

          // Category links (for custom playlists, or custom category links added to real sources)
          for (const link of links) {
            const cat = nativeCategoryMap.get(link.category_id);
            const displayName = link.custom_name || cat?.alias || cat?.category_name || link.category_id;
            const isCustomLink = link.source_id === 'custom' || link.category_id.startsWith('custom:');

            const catId = `link:${link.id}`;

            let count = 0;
            if (!isCustomLink) {
              const nativeCnt = nativeCounts[`${link.source_id}:${link.category_id}`] || 0;
              const manualLinkCnt = manualCounts[`${targetPlaylistId}:link:${link.id}`] || 0;
              const manualCatCnt = manualCounts[`${targetPlaylistId}:${link.category_id}`] || 0;
              count = nativeCnt + manualLinkCnt + manualCatCnt;
            } else {
              const manualLinkCnt = manualCounts[`${targetPlaylistId}:link:${link.id}`] || 0;
              const manualCatCnt = manualCounts[`${targetPlaylistId}:${link.category_id}`] || 0;
              count = manualLinkCnt + manualCatCnt;
            }

            sourceCats.push({
              category_id: catId,
              category_name: displayName,
              source_id: source.id,
              channel_count: count,
              enabled: true,
              display_order: link.display_order ?? 0,
              folder_id: link.folder_id || null,
            } as any);
          }

          // Sort sourceCats matching CategoryStrip.tsx sorting logic
          const isAlphabetical = categorySortOrder === 'alphabetical' && !isCategorySortCustomized(targetPlaylistId);

          if (isAlphabetical) {
            sourceCats.sort((a, b) => {
              const aKey = `${source.id}:${a.category_id}`;
              const bKey = `${source.id}:${b.category_id}`;
              const aPinned = pinnedCategories.includes(aKey);
              const bPinned = pinnedCategories.includes(bKey);
              if (aPinned && !bPinned) return -1;
              if (!aPinned && bPinned) return 1;
              return a.category_name.localeCompare(b.category_name);
            });
          } else {
            sourceCats.sort((a, b) => {
              const aKey = `${source.id}:${a.category_id}`;
              const bKey = `${source.id}:${b.category_id}`;
              const aPinned = pinnedCategories.includes(aKey);
              const bPinned = pinnedCategories.includes(bKey);
              if (aPinned && !bPinned) return -1;
              if (!aPinned && bPinned) return 1;
              const orderA = a.display_order ?? 0;
              const orderB = b.display_order ?? 0;
              if (orderA !== orderB) return orderA - orderB;
              return a.category_name.localeCompare(b.category_name);
            });
          }

          activeCategories.push(...sourceCats);
        }

        if (!isMounted) return;

        setSources(enabledSources);
        setCategories(activeCategories);
        setCategoryFolders(allCategoryFolders);

        // Auto-expand sources that have selected categories
        const sourceIdsWithSelection = new Set<string>();
        for (const cat of activeCategories) {
          if (selectedCategoryIds.has(cat.category_id)) {
            sourceIdsWithSelection.add(cat.source_id);
          }
        }
        setExpandedSources(prev => new Set([...prev, ...sourceIdsWithSelection]));
      } catch (err) {
        console.error('[AdvancedSearchModal] Failed to load data:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadData();
    return () => { isMounted = false; };
  }, [isOpen]);

  // Reset state when initialConfig changes
  useEffect(() => {
    if (initialConfig) {
      setQuery(initialConfig.query);
      setScope(initialConfig.scope);
      setUseForRegular(initialConfig.useForRegular);
      setSelectedSourceIds(new Set(initialConfig.sourceIds));
      setSelectedCategoryIds(new Set(initialConfig.categoryIds));
    }
  }, [initialConfig]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Group categories by source preserving exact display_order
  const categoriesBySource = useMemo(() => {
    const grouped = new Map<string, StoredCategory[]>();
    for (const cat of categories) {
      const list = grouped.get(cat.source_id) || [];
      list.push(cat);
      grouped.set(cat.source_id, list);
    }
    return grouped;
  }, [categories]);

  const toggleSource = useCallback((sourceId: string) => {
    setSelectedSourceIds(prev => {
      const next = new Set(prev);
      if (next.has(sourceId)) {
        next.delete(sourceId);
        // Also unselect all categories from this source
        setSelectedCategoryIds(catPrev => {
          const catNext = new Set(catPrev);
          for (const cat of categoriesBySource.get(sourceId) || []) {
            catNext.delete(cat.category_id);
          }
          return catNext;
        });
      } else {
        next.add(sourceId);
      }
      return next;
    });
  }, [categoriesBySource]);

  const toggleCategory = useCallback((categoryId: string, sourceId: string) => {
    setSelectedCategoryIds(prev => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
        // Also select the source
        setSelectedSourceIds(srcPrev => new Set([...srcPrev, sourceId]));
      }
      return next;
    });
  }, []);

  const toggleFolderInSearch = useCallback((folderId: string, sourceId: string) => {
    const sourceCategories = categoriesBySource.get(sourceId) || [];
    const folderCategories = sourceCategories.filter(c => (c as any).folder_id === folderId);
    if (folderCategories.length === 0) return;

    setSelectedCategoryIds(prev => {
      const next = new Set(prev);
      const allSelected = folderCategories.every(c => next.has(c.category_id));

      if (allSelected) {
        for (const c of folderCategories) {
          next.delete(c.category_id);
        }
      } else {
        for (const c of folderCategories) {
          next.add(c.category_id);
        }
        setSelectedSourceIds(srcPrev => new Set([...srcPrev, sourceId]));
      }
      return next;
    });
  }, [categoriesBySource]);

  const toggleExpandSource = useCallback((sourceId: string) => {
    setExpandedSources(prev => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedSourceIds(new Set(sources.map(s => s.id)));
    setSelectedCategoryIds(new Set(categories.map(c => c.category_id)));
  }, [sources, categories]);

  const handleClearAll = useCallback(() => {
    setSelectedSourceIds(new Set());
    setSelectedCategoryIds(new Set());
  }, []);

  const handleSubmit = useCallback(() => {
    onSearch({
      query: query.trim(),
      scope,
      sourceIds: Array.from(selectedSourceIds),
      categoryIds: Array.from(selectedCategoryIds),
      useForRegular,
    });
  }, [query, scope, selectedSourceIds, selectedCategoryIds, useForRegular, onSearch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  }, [handleSubmit]);

  if (!isOpen) return null;

  const hasSelection = selectedSourceIds.size > 0 || selectedCategoryIds.size > 0;
  const canSearch = query.trim().length >= 2;

  return createPortal(
    <div className="advanced-search-overlay">
      <div className="advanced-search-modal">
        {/* Header */}
        <div className="advanced-search-header">
          <div className="advanced-search-title">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="m21 21-4.3-4.3"></path>
            </svg>
            <h2>{i18n.t('epg:advancedSearch')}</h2>
          </div>
          <button className="advanced-search-close-btn" onClick={onClose} aria-label={i18n.t('common:close')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="advanced-search-body">
          {/* Search Input */}
          <div className="advanced-search-section">
            <label className="advanced-search-label">{i18n.t('epg:searchTerm')}</label>
            <div className="advanced-search-input-wrap">
              <svg className="advanced-search-input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"></circle>
                <path d="m21 21-4.3-4.3"></path>
              </svg>
              <input
                type="text"
                className="advanced-search-input"
                placeholder={i18n.t('epg:searchTermPlaceholder')}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
              />
              {query && (
                <button className="advanced-search-input-clear" onClick={() => setQuery('')}>
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Search Scope */}
          <div className="advanced-search-section">
            <label className="advanced-search-label">{i18n.t('epg:searchIn')}</label>
            <div className="advanced-search-scope">
              <button
                className={`scope-btn ${scope === 'channels' ? 'active' : ''}`}
                onClick={() => setScope('channels')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                  <polyline points="17 2 12 7 7 2"></polyline>
                </svg>
                {i18n.t('epg:scopeChannels')}
              </button>
              <button
                className={`scope-btn ${scope === 'epg' ? 'active' : ''}`}
                onClick={() => setScope('epg')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12z" />
                  <path d="M16 3v4" />
                  <path d="M8 3v4" />
                  <path d="M4 11h16" />
                </svg>
                {i18n.t('epg:scopeEpg')}
              </button>
              <button
                className={`scope-btn ${scope === 'both' ? 'active' : ''}`}
                onClick={() => setScope('both')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                  <polyline points="17 2 12 7 7 2"></polyline>
                  <path d="M4 11h16" />
                </svg>
                {i18n.t('epg:scopeBoth')}
              </button>
            </div>
          </div>

          {/* Source / Category Filters */}
          <div className="advanced-search-section">
            <div className="advanced-search-label-row">
              <label className="advanced-search-label">{i18n.t('epg:sourcesAndCategories')}</label>
              <div className="advanced-search-actions">
                <button className="action-link" onClick={handleSelectAll}>{i18n.t('common:selectAll')}</button>
                <span className="action-divider">|</span>
                <button className="action-link" onClick={handleClearAll}>{i18n.t('epg:clear')}</button>
              </div>
            </div>

            <div className="advanced-search-filters">
              {loading ? (
                <div className="advanced-search-loading">
                  <div className="spinner-small"></div>
                  <span>{i18n.t('epg:loadingSources')}</span>
                </div>
              ) : sources.length === 0 ? (
                <div className="advanced-search-empty">{i18n.t('epg:noEnabledSources')}</div>
              ) : (
                sources.map(source => {
                  const sourceCategories = categoriesBySource.get(source.id) || [];
                  const isExpanded = expandedSources.has(source.id);
                  const isSourceSelected = selectedSourceIds.has(source.id);
                  const selectedCount = sourceCategories.filter(c => selectedCategoryIds.has(c.category_id)).length;
                  const allSelected = sourceCategories.length > 0 && selectedCount === sourceCategories.length;
                  const isIndeterminate = selectedCount > 0 && selectedCount < sourceCategories.length;

                  return (
                    <div key={source.id} className="filter-source-group">
                      <div
                        className={`filter-source-header ${isExpanded ? 'expanded' : ''}`}
                        onClick={() => toggleExpandSource(source.id)}
                      >
                        <svg className="filter-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                        <div
                          className={`filter-checkbox ${isSourceSelected ? 'checked' : ''} ${isIndeterminate ? 'indeterminate' : ''}`}
                          onClick={e => { e.stopPropagation(); toggleSource(source.id); }}
                        >
                          {isSourceSelected && !isIndeterminate && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                          )}
                          {isIndeterminate && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="5" y1="12" x2="19" y2="12"></line>
                            </svg>
                          )}
                        </div>
                        <span className="filter-source-name">{source.name}</span>
                        <span className="filter-source-count">
                          {selectedCount > 0 ? `${selectedCount}/${sourceCategories.length}` : sourceCategories.length}
                        </span>
                      </div>

                      {isExpanded && (() => {
                        const targetPlaylistId = source.id.startsWith('playlist:') ? source.id.replace('playlist:', '') : source.id;
                        const sourceFolders = categoryFolders
                          .filter(f => f.playlist_id === targetPlaylistId)
                          .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));

                        const renderCatItem = (cat: StoredCategory) => {
                          const isCatSelected = selectedCategoryIds.has(cat.category_id);
                          return (
                            <div
                              key={cat.category_id}
                              className={`filter-category-item ${isCatSelected ? 'selected' : ''}`}
                              onClick={() => toggleCategory(cat.category_id, source.id)}
                            >
                              <div className={`filter-checkbox ${isCatSelected ? 'checked' : ''}`}>
                                {isCatSelected && (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="20 6 9 17 4 12"></polyline>
                                  </svg>
                                )}
                              </div>
                              <span className="filter-category-name">{cat.category_name}</span>
                              <span className="filter-category-count">{cat.channel_count ?? 0}</span>
                            </div>
                          );
                        };

                        if (sourceFolders.length > 0) {
                          const rootCats = sourceCategories.filter(c => !(c as any).folder_id || !sourceFolders.some(f => f.folder_id === (c as any).folder_id));

                          return (
                            <div className="filter-categories">
                              {sourceFolders.map((folder: CategoryFolder) => {
                                const folderCats = sourceCategories.filter(c => (c as any).folder_id === folder.folder_id);
                                const isFolderExpanded = expandedFolders.has(folder.folder_id);
                                const folderSelectedCount = folderCats.filter(c => selectedCategoryIds.has(c.category_id)).length;
                                const isFolderSelected = folderCats.length > 0 && folderSelectedCount === folderCats.length;
                                const isFolderIndeterminate = folderSelectedCount > 0 && folderSelectedCount < folderCats.length;

                                return (
                                  <div key={folder.folder_id} className="filter-folder-group">
                                    <div
                                      className="filter-folder-header"
                                      onClick={() => {
                                        setExpandedFolders(prev => {
                                          const next = new Set(prev);
                                          if (next.has(folder.folder_id)) next.delete(folder.folder_id);
                                          else next.add(folder.folder_id);
                                          return next;
                                        });
                                      }}
                                    >
                                      <svg className="filter-chevron" style={{ transform: isFolderExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="9 18 15 12 9 6"></polyline>
                                      </svg>
                                      <div
                                        className={`filter-checkbox ${isFolderSelected ? 'checked' : ''} ${isFolderIndeterminate ? 'indeterminate' : ''}`}
                                        onClick={e => { e.stopPropagation(); toggleFolderInSearch(folder.folder_id, source.id); }}
                                      >
                                        {isFolderSelected && !isFolderIndeterminate && (
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="20 6 9 17 4 12"></polyline>
                                          </svg>
                                        )}
                                        {isFolderIndeterminate && (
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                            <line x1="5" y1="12" x2="19" y2="12"></line>
                                          </svg>
                                        )}
                                      </div>
                                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary, #00d4ff)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                      </svg>
                                      <span className="filter-folder-name">{folder.name}</span>
                                      <span className="filter-source-count">
                                        {folderSelectedCount > 0 ? `${folderSelectedCount}/${folderCats.length}` : folderCats.length}
                                      </span>
                                    </div>

                                    {isFolderExpanded && (
                                      <div className="filter-folder-categories">
                                        {folderCats.map(cat => renderCatItem(cat))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}

                              {rootCats.length > 0 && rootCats.map(cat => renderCatItem(cat))}
                            </div>
                          );
                        }

                        return (
                          <div className="filter-categories">
                            {sourceCategories.map(cat => renderCatItem(cat))}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Use for regular search toggle */}
          <div className="advanced-search-section">
            <label className="advanced-search-toggle" onClick={() => setUseForRegular(!useForRegular)}>
              <div className={`toggle-switch ${useForRegular ? 'on' : ''}`}>
                <div className="toggle-knob"></div>
              </div>
              <span className="toggle-label">{i18n.t('epg:useForRegularSearch')}</span>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="advanced-search-footer">
          <button className="advanced-search-btn secondary" onClick={onClose}>
            {i18n.t('common:cancel')}
          </button>
          <button
            className={`advanced-search-btn primary ${!canSearch ? 'disabled' : ''}`}
            onClick={handleSubmit}
            disabled={!canSearch}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="m21 21-4.3-4.3"></path>
            </svg>
            {i18n.t('epg:search')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
