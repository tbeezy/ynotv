import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { db } from '../../db';
import { getAvailableCategories } from '../../services/sports';
import {
  ALL_LEAGUES,
  useSportsSettingsStore,
  type LeagueConfig,
} from '../../stores/sportsSettingsStore';
import {
  useLeagueSearchConfigStore,
  type LeagueSearchConfig,
} from '../../stores/leagueSearchConfigStore';
import './styles/SportsSearchSettingsModal.css';

export interface SearchCategoryOption {
  id: string;
  name: string;
  source_id?: string;
  source_name?: string;
  channel_count?: number;
}

export interface SearchSourceOption {
  id: string;
  name: string;
}

interface SportsSearchSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialLeagueId?: string;
}

export const SportsSearchSettingsModal: React.FC<SportsSearchSettingsModalProps> = ({
  isOpen,
  onClose,
  initialLeagueId,
}) => {
  const { t } = useTranslation(['sports', 'common']);
  const enabledLeagueIds = useSportsSettingsStore((s) => s.enabledLeagues);
  const { getConfig, setConfig, resetConfig, hasCustomConfig } = useLeagueSearchConfigStore();

  const [selectedSportCategory, setSelectedSportCategory] = useState<string>('all');
  const [selectedLeagueId, setSelectedLeagueId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'sources' | 'categories'>('sources');

  const [sources, setSources] = useState<SearchSourceOption[]>([]);
  const [categories, setCategories] = useState<SearchCategoryOption[]>([]);

  // Per-league temporary edit state
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [categorySearch, setCategorySearch] = useState('');
  const [expandedSourceIds, setExpandedSourceIds] = useState<Set<string>>(new Set());

  // Filter enabled leagues based on sportsSettingsStore
  const enabledLeagues: LeagueConfig[] = useMemo(() => {
    const valid = ALL_LEAGUES.filter((l) => enabledLeagueIds.includes(l.id)).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    if (valid.length === 0) {
      return [...ALL_LEAGUES].sort((a, b) => a.name.localeCompare(b.name));
    }
    return valid;
  }, [enabledLeagueIds]);

  // Filter leagues by sport category
  const filteredLeagues = useMemo(() => {
    if (selectedSportCategory === 'all') return enabledLeagues;
    return enabledLeagues.filter((l) => l.category === selectedSportCategory);
  }, [enabledLeagues, selectedSportCategory]);

  const selectedLeague = useMemo(() => {
    return enabledLeagues.find((l) => l.id === selectedLeagueId) || enabledLeagues[0] || null;
  }, [enabledLeagues, selectedLeagueId]);

  // Set default selected league
  useEffect(() => {
    if (isOpen) {
      if (initialLeagueId && enabledLeagues.some((l) => l.id === initialLeagueId)) {
        setSelectedLeagueId(initialLeagueId);
      } else if (
        !selectedLeagueId ||
        !enabledLeagues.some((l) => l.id === selectedLeagueId)
      ) {
        if (enabledLeagues.length > 0) {
          setSelectedLeagueId(enabledLeagues[0].id);
        }
      }
    }
  }, [isOpen, initialLeagueId, enabledLeagues, selectedLeagueId]);

  // Close on Escape for consistency with the other sports modals
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Lock background scroll while the modal is open
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  // Load sources and enabled categories from DB
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    async function loadData() {
      try {
        const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
        const rawSources = sourcesResult.data || [];
        const enabledSources = rawSources.filter((s: any) => s.enabled !== false);
        const sourceMap = new Map<string, string>();
        for (const s of enabledSources) {
          sourceMap.set(s.id, s.name);
        }

        const enabledSourceIds = new Set(enabledSources.map((s: any) => s.id));
        const allDbCategories = await db.categories.toArray();
        const activeCategories = allDbCategories.filter(
          (c) => c.enabled !== false && (!c.source_id || enabledSourceIds.has(c.source_id))
        );

        if (!cancelled) {
          setSources(
            enabledSources.map((s: any) => ({
              id: s.id,
              name: s.name,
            }))
          );

          setCategories(
            activeCategories.map((c) => ({
              id: c.category_id,
              name: c.category_name,
              source_id: c.source_id,
              source_name: c.source_id ? sourceMap.get(c.source_id) : undefined,
              channel_count: c.channel_count,
            }))
          );
        }
      } catch (err) {
        console.error('[SportsSearchSettingsModal] Failed to load sources/categories:', err);
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Sync state when selectedLeague changes
  useEffect(() => {
    if (!selectedLeague?.id) return;
    let cancelled = false;
    (async () => {
      await useLeagueSearchConfigStore.getState().ensureLoaded();
      if (cancelled) return;
      const cfg = getConfig(selectedLeague.id);
      setSelectedSourceIds(cfg.sourceIds || []);
      setSelectedCategoryIds(cfg.categoryIds || []);
      setCategorySearch('');
      setExpandedSourceIds(new Set());
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedLeague?.id, getConfig]);

  // Filter categories by search and selected sources
  const filteredCategories = useMemo(() => {
    let list = categories;
    if (selectedSourceIds.length > 0) {
      list = list.filter((c) => !c.source_id || selectedSourceIds.includes(c.source_id));
    }
    if (categorySearch.trim()) {
      const q = categorySearch.toLowerCase().trim();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.source_name && c.source_name.toLowerCase().includes(q))
      );
    }
    return list;
  }, [categories, selectedSourceIds, categorySearch]);

  // Group filtered categories by source
  const categoriesBySource = useMemo(() => {
    const sourceMap = new Map<string, { sourceName: string; categories: SearchCategoryOption[] }>();

    for (const s of sources) {
      if (selectedSourceIds.length === 0 || selectedSourceIds.includes(s.id)) {
        sourceMap.set(s.id, { sourceName: s.name, categories: [] });
      }
    }

    for (const c of filteredCategories) {
      const sId = c.source_id || 'other';
      const sName =
        c.source_name ||
        (c.source_id && sources.find((s) => s.id === c.source_id)?.name) ||
        t('sports:other');
      if (!sourceMap.has(sId)) {
        sourceMap.set(sId, { sourceName: sName, categories: [] });
      }
      sourceMap.get(sId)!.categories.push(c);
    }

    const groups: Array<{ sourceId: string; sourceName: string; categories: SearchCategoryOption[] }> = [];
    for (const [sourceId, { sourceName, categories: cats }] of sourceMap.entries()) {
      if (cats.length > 0) {
        groups.push({ sourceId, sourceName, categories: cats });
      }
    }
    return groups;
  }, [filteredCategories, sources, selectedSourceIds, t]);

  // When searching, auto-expand all matching source accordions
  useEffect(() => {
    if (categorySearch.trim()) {
      const allMatchingIds = categoriesBySource.map((g) => g.sourceId);
      setExpandedSourceIds(new Set(allMatchingIds));
    }
  }, [categorySearch, categoriesBySource]);

  const handleToggleExpandSource = (sourceId: string) => {
    setExpandedSourceIds((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }
      return next;
    });
  };

  const handleExpandAllSources = () => {
    setExpandedSourceIds(new Set(categoriesBySource.map((g) => g.sourceId)));
  };

  const handleCollapseAllSources = () => {
    setExpandedSourceIds(new Set());
  };

  const handleToggleSource = (sourceId: string) => {
    setSelectedSourceIds((prev) => {
      if (prev.includes(sourceId)) {
        return prev.filter((id) => id !== sourceId);
      }
      return [...prev, sourceId];
    });
  };

  const handleSelectAllSources = () => {
    setSelectedSourceIds([]);
  };

  const handleToggleCategory = (catId: string) => {
    setSelectedCategoryIds((prev) => {
      if (prev.includes(catId)) {
        return prev.filter((id) => id !== catId);
      }
      return [...prev, catId];
    });
  };

  const handleSelectSportsCategoriesOnly = () => {
    const sportsRegex = /sport|nfl|nba|nhl|mlb|soccer|football|basket|hockey|baseball|espn|fox|cbs|nbc|event|game|live|dazn|tsn|bein|super/i;
    const sportsCatIds = categories
      .filter((c) => sportsRegex.test(c.name))
      .map((c) => c.id);
    setSelectedCategoryIds(Array.from(new Set(sportsCatIds)));
  };

  const handleSelectAllCategories = () => {
    setSelectedCategoryIds([]);
  };

  const handleClearCategories = () => {
    setSelectedCategoryIds([]);
  };

  const handleSelectMatchingCategories = () => {
    const matchingIds = filteredCategories.map((c) => c.id);
    setSelectedCategoryIds((prev) => Array.from(new Set([...prev, ...matchingIds])));
  };

  const handleDeselectMatchingCategories = () => {
    const matchingIds = new Set(filteredCategories.map((c) => c.id));
    setSelectedCategoryIds((prev) => prev.filter((id) => !matchingIds.has(id)));
  };

  const handleToggleSourceCategories = (sourceCats: SearchCategoryOption[]) => {
    const sourceCatIds = sourceCats.map((c) => c.id);
    const allSelected = sourceCatIds.every((id) => selectedCategoryIds.includes(id));
    if (allSelected) {
      setSelectedCategoryIds((prev) => prev.filter((id) => !sourceCatIds.includes(id)));
    } else {
      setSelectedCategoryIds((prev) => Array.from(new Set([...prev, ...sourceCatIds])));
    }
  };

  const handleReset = () => {
    if (!selectedLeague) return;
    resetConfig(selectedLeague.id);
    setSelectedSourceIds([]);
    setSelectedCategoryIds([]);
    setExpandedSourceIds(new Set());
  };

  const handleSave = () => {
    if (!selectedLeague) return;
    const config: LeagueSearchConfig = {
      sourceIds: selectedSourceIds,
      categoryIds: selectedCategoryIds,
    };
    setConfig(selectedLeague.id, config);
    onClose();
  };

  const hasActiveSearch = categorySearch.trim().length > 0;
  const isCustomConfigActive = selectedLeague ? hasCustomConfig(selectedLeague.id) : false;

  if (!isOpen) return null;

  return createPortal(
    <div className="sss-overlay" onClick={onClose}>
      <div className="sss-modal" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="sss-header">
          <div className="sss-header-info">
            <div className="sss-header-title-row">
              <span className="sss-header-icon">🔍</span>
              <h2 className="sss-title">{t('sports:searchSettings', { defaultValue: 'Stream Search Settings' })}</h2>
              {selectedLeague && (
                <span className="sss-league-badge-top">{selectedLeague.name}</span>
              )}
            </div>
            <p className="sss-subtitle">
              {t('sports:searchSettingsSubtitle', { league: selectedLeague?.name || t('sports:eachLeague') })}
            </p>
          </div>
          <button className="sss-close-btn" onClick={onClose} aria-label={t('common:close')}>
            ✕
          </button>
        </div>

        {/* League Selector Strip */}
        <div className="sss-league-selector-section">
          {/* Category filter pills */}
          <div className="sss-category-pills-row">
            <button
              className={`sss-category-pill ${selectedSportCategory === 'all' ? 'active' : ''}`}
              onClick={() => setSelectedSportCategory('all')}
            >
              {t('sports:all', { defaultValue: 'All' })}
            </button>
            {getAvailableCategories().map((cat) => (
              <button
                key={cat.id}
                className={`sss-category-pill ${selectedSportCategory === cat.id ? 'active' : ''}`}
                onClick={() => setSelectedSportCategory(cat.id)}
              >
                {cat.name}
              </button>
            ))}
          </div>

          {/* League pills */}
          <div className="sss-leagues-pills-scroll tcs-custom-scrollbar">
            {filteredLeagues.map((l: LeagueConfig) => {
              const isSelected = l.id === selectedLeague?.id;
              const hasCustom = hasCustomConfig(l.id);
              return (
                <button
                  key={l.id}
                  className={`sss-league-pill ${isSelected ? 'active' : ''} ${hasCustom ? 'has-custom' : ''}`}
                  onClick={() => setSelectedLeagueId(l.id)}
                >
                  <span className="sss-league-pill-name">{l.name}</span>
                  {hasCustom && <span className="sss-league-pill-custom-dot" title={t('sports:customFiltersActiveTitle')} />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Scope Navigation Tabs */}
        <div className="sss-nav-tabs">
          <button
            className={`sss-nav-tab ${activeTab === 'sources' ? 'active' : ''}`}
            onClick={() => setActiveTab('sources')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span>{t('sports:sourceScope', { defaultValue: 'Playlist Sources' })}</span>
            <span className="sss-badge-pill">
              {selectedSourceIds.length === 0
                ? t('sports:allSources', { defaultValue: 'All Sources' })
                : `${selectedSourceIds.length}`}
            </span>
          </button>

          <button
            className={`sss-nav-tab ${activeTab === 'categories' ? 'active' : ''}`}
            onClick={() => setActiveTab('categories')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span>{t('sports:categoryScope', { defaultValue: 'Category Filters' })}</span>
            <span className="sss-badge-pill">
              {selectedCategoryIds.length === 0
                ? t('sports:allCategories', { defaultValue: 'All Categories' })
                : `${selectedCategoryIds.length}`}
            </span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="sss-content-body tcs-custom-scrollbar">
          {/* TAB 1: SOURCES SCOPE */}
          {activeTab === 'sources' && (
            <div className="sss-section">
              <div className="sss-section-header">
                <h3>{t('sports:sourceScope', { defaultValue: 'Playlist Sources' })}</h3>
                <p>{t('sports:sourceScopeDescForLeague', { league: selectedLeague?.name || '' })}</p>
              </div>

              <div className="sss-filter-toolbar">
                <button
                  className={`sss-btn-mini ${selectedSourceIds.length === 0 ? 'active' : ''}`}
                  onClick={handleSelectAllSources}
                >
                  {t('sports:allSources', { defaultValue: 'All Sources (Default)' })}
                </button>
                <span className="sss-toolbar-count">
                  {selectedSourceIds.length === 0
                    ? t('sports:searchingAllSources', { count: sources.length })
                    : t('sports:sourcesSelected', { selected: selectedSourceIds.length, total: sources.length })}
                </span>
              </div>

              <div className="sss-checkbox-grid">
                {sources.map((s) => {
                  const isChecked =
                    selectedSourceIds.length === 0 || selectedSourceIds.includes(s.id);
                  return (
                    <label
                      key={s.id}
                      className={`sss-checkbox-card ${isChecked ? 'checked' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedSourceIds.includes(s.id)}
                        onChange={() => handleToggleSource(s.id)}
                      />
                      <span className="sss-checkbox-custom" />
                      <div className="sss-checkbox-label">
                        <span className="sss-source-name">{s.name}</span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 2: CATEGORIES SCOPE */}
          {activeTab === 'categories' && (
            <div className="sss-section">
              <div className="sss-section-header">
                <h3>{t('sports:categoryScope', { defaultValue: 'Category Filters' })}</h3>
                <p>{t('sports:categoryScopeDescForLeague', { league: selectedLeague?.name || '' })}</p>
              </div>

              <div className="sss-category-controls">
                <div className="sss-search-wrap">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    className="sss-search-input"
                    placeholder={t('sports:searchCategories', { defaultValue: 'Search categories...' })}
                    value={categorySearch}
                    onChange={(e) => setCategorySearch(e.target.value)}
                  />
                  {categorySearch && (
                    <button className="sss-search-clear" onClick={() => setCategorySearch('')}>
                      ✕
                    </button>
                  )}
                </div>

                <div className="sss-category-preset-strip">
                  {hasActiveSearch && filteredCategories.length > 0 ? (
                    <>
                      <button
                        className="sss-btn-mini highlight"
                        onClick={handleSelectMatchingCategories}
                      >
                        ✓ {t('sports:selectMatching', { count: filteredCategories.length, defaultValue: `Select Matching (${filteredCategories.length})` })}
                      </button>
                      <button
                        className="sss-btn-mini"
                        onClick={handleDeselectMatchingCategories}
                      >
                        ✕ {t('sports:deselectMatching', { defaultValue: 'Deselect Matching' })}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className={`sss-btn-mini ${selectedCategoryIds.length === 0 ? 'active' : ''}`}
                        onClick={handleSelectAllCategories}
                      >
                        {t('sports:allCategories', { defaultValue: 'All Categories (Default)' })}
                      </button>
                      <button
                        className="sss-btn-mini highlight"
                        onClick={handleSelectSportsCategoriesOnly}
                      >
                        ⚡ {t('sports:sportsOnly', { defaultValue: 'Sports Only' })}
                      </button>
                      {selectedCategoryIds.length > 0 && (
                        <button className="sss-btn-mini" onClick={handleClearCategories}>
                          {t('sports:clearCount', { count: selectedCategoryIds.length })}
                        </button>
                      )}
                    </>
                  )}

                  <div className="sss-expand-collapse-group">
                    <button className="sss-btn-mini-link" onClick={handleExpandAllSources}>
                      {t('sports:expandAll')}
                    </button>
                    <span className="sss-divider-dot">•</span>
                    <button className="sss-btn-mini-link" onClick={handleCollapseAllSources}>
                      {t('sports:collapseAll')}
                    </button>
                  </div>
                </div>
              </div>

              <div className="sss-category-count-bar">
                <span>
                  {selectedCategoryIds.length === 0
                    ? t('sports:searchingAllCategories', { count: categories.length })
                    : t('sports:categoriesSelected', { count: selectedCategoryIds.length })}
                </span>
                <span className="sss-showing-count">
                  {t('sports:categoriesInSources', { categories: filteredCategories.length, sources: categoriesBySource.length })}
                </span>
              </div>

              <div className="sss-categories-list">
                {categoriesBySource.length === 0 ? (
                  <div className="sss-empty-state">
                    <span>{t('sports:noCategoriesMatching', { query: categorySearch })}</span>
                  </div>
                ) : (
                  categoriesBySource.map((group) => {
                    const isExpanded = expandedSourceIds.has(group.sourceId);
                    const groupSelectedCount = group.categories.filter((c) =>
                      selectedCategoryIds.includes(c.id)
                    ).length;
                    const isAllGroupSelected =
                      group.categories.length > 0 &&
                      groupSelectedCount === group.categories.length;
                    const isSomeGroupSelected =
                      groupSelectedCount > 0 && !isAllGroupSelected;

                    return (
                      <div
                        key={group.sourceId}
                        className={`sss-source-category-group ${isExpanded ? 'is-expanded' : ''}`}
                      >
                        <div
                          className="sss-source-group-header"
                          onClick={() => handleToggleExpandSource(group.sourceId)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleToggleExpandSource(group.sourceId);
                            }
                          }}
                        >
                          <div className="sss-source-group-left">
                            <span className={`sss-source-chevron ${isExpanded ? 'expanded' : ''}`}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="9 18 15 12 9 6" />
                              </svg>
                            </span>
                            <label
                              className="sss-source-group-checkbox"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                checked={isAllGroupSelected}
                                ref={(el) => {
                                  if (el) el.indeterminate = isSomeGroupSelected;
                                }}
                                onChange={() => handleToggleSourceCategories(group.categories)}
                              />
                              <span className="sss-checkbox-custom" />
                            </label>
                            <span className="sss-source-group-title">{group.sourceName}</span>
                            <span className="sss-source-total-count">({group.categories.length})</span>
                          </div>

                          <div className="sss-source-group-right">
                            <span className={`sss-source-group-badge ${groupSelectedCount > 0 ? 'active' : ''}`}>
                              {groupSelectedCount > 0
                                ? t('sports:selectedOutOf', { selected: groupSelectedCount, total: group.categories.length })
                                : t('sports:categoryCount', { count: group.categories.length })}
                            </span>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="sss-source-group-items">
                            {group.categories.map((c) => {
                              const isSelected = selectedCategoryIds.includes(c.id);
                              return (
                                <label
                                  key={`${c.source_id || ''}:${c.id}`}
                                  className={`sss-category-row ${isSelected ? 'selected' : ''}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => handleToggleCategory(c.id)}
                                  />
                                  <span className="sss-checkbox-custom" />
                                  <div className="sss-category-row-info">
                                    <span className="sss-cat-name">{c.name}</span>
                                  </div>
                                  {c.channel_count !== undefined && c.channel_count > 0 && (
                                    <span className="sss-cat-count">{t('sports:channelCountShort', { count: c.channel_count })}</span>
                                  )}
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="sss-footer">
          <button
            className="sss-btn-reset"
            onClick={handleReset}
            title={t('sports:resetLeagueSettings', { defaultValue: 'Reset this league to all sources & categories' })}
            disabled={!isCustomConfigActive}
          >
            {t('sports:resetLeagueSettings', { defaultValue: 'Reset League Filters' })}
          </button>
          <div className="sss-footer-right">
            <button className="sss-btn-cancel" onClick={onClose}>
              {t('common:cancel', { defaultValue: 'Cancel' })}
            </button>
            <button className="sss-btn-save" onClick={handleSave}>
              {t('common:save', { defaultValue: 'Save Settings' })}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
