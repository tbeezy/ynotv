import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { LeagueConfig } from '../../stores/sportsSettingsStore';
import {
  useLeagueAutoLinkConfigStore,
  type LeagueAutoLinkConfig,
  type AutoLinkMatchMode,
  DEFAULT_AUTOLINK_CONFIG,
} from '../../stores/leagueAutoLinkConfigStore';
import './styles/AutoLinkSettingsModal.css';

export interface CategoryOption {
  id: string;
  name: string;
  source_id?: string;
  source_name?: string;
  channel_count?: number;
}

export interface SourceOption {
  id: string;
  name: string;
}

interface AutoLinkSettingsModalProps {
  league: LeagueConfig;
  isOpen: boolean;
  onClose: () => void;
  onSaveAndRun?: (config: LeagueAutoLinkConfig) => void;
  sources: SourceOption[];
  categories: CategoryOption[];
}

export const AutoLinkSettingsModal: React.FC<AutoLinkSettingsModalProps> = ({
  league,
  isOpen,
  onClose,
  onSaveAndRun,
  sources,
  categories,
}) => {
  const { t } = useTranslation(['sports', 'common']);
  const { getConfig, setConfig, resetConfig } = useLeagueAutoLinkConfigStore();

  const [matchMode, setMatchMode] = useState<AutoLinkMatchMode>('both');
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [minConfidence, setMinConfidence] = useState<number>(0.7);
  const [maxCandidatesPerTeam, setMaxCandidatesPerTeam] = useState<number>(1);
  const [autoApply, setAutoApply] = useState<boolean>(false);
  const [categorySearch, setCategorySearch] = useState('');
  const [activeTab, setActiveTab] = useState<'strategy' | 'sources' | 'categories'>('strategy');
  const [expandedSourceIds, setExpandedSourceIds] = useState<Set<string>>(new Set());

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

  // Load saved config when modal opens or league changes
  useEffect(() => {
    if (!isOpen || !league?.id) return;
    let cancelled = false;
    (async () => {
      await useLeagueAutoLinkConfigStore.getState().ensureLoaded();
      if (cancelled) return;
      const cfg = getConfig(league.id);
      setMatchMode(cfg.matchMode || 'both');
      setSelectedSourceIds(cfg.sourceIds || []);
      setSelectedCategoryIds(cfg.categoryIds || []);
      setMinConfidence(cfg.minConfidence ?? 0.7);
      setMaxCandidatesPerTeam(cfg.maxCandidatesPerTeam ?? 1);
      setAutoApply(cfg.autoApply ?? false);
      setCategorySearch('');
      setExpandedSourceIds(new Set());
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, league?.id, getConfig]);

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

  // Group filtered categories by Source
  const categoriesBySource = useMemo(() => {
    const sourceMap = new Map<string, { sourceName: string; categories: CategoryOption[] }>();

    // Pre-populate with sources list to preserve display order
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

    const groups: Array<{ sourceId: string; sourceName: string; categories: CategoryOption[] }> = [];
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

  const handleToggleSourceCategories = (sourceCats: CategoryOption[]) => {
    const sourceCatIds = sourceCats.map((c) => c.id);
    const allSelected = sourceCatIds.every((id) => selectedCategoryIds.includes(id));
    if (allSelected) {
      setSelectedCategoryIds((prev) => prev.filter((id) => !sourceCatIds.includes(id)));
    } else {
      setSelectedCategoryIds((prev) => Array.from(new Set([...prev, ...sourceCatIds])));
    }
  };

  const handleReset = () => {
    resetConfig(league.id);
    setMatchMode(DEFAULT_AUTOLINK_CONFIG.matchMode);
    setSelectedSourceIds([]);
    setSelectedCategoryIds([]);
    setMinConfidence(DEFAULT_AUTOLINK_CONFIG.minConfidence);
    setMaxCandidatesPerTeam(DEFAULT_AUTOLINK_CONFIG.maxCandidatesPerTeam);
    setAutoApply(DEFAULT_AUTOLINK_CONFIG.autoApply);
    setExpandedSourceIds(new Set());
  };

  const handleSave = () => {
    const config: LeagueAutoLinkConfig = {
      matchMode,
      sourceIds: selectedSourceIds,
      categoryIds: selectedCategoryIds,
      minConfidence,
      maxCandidatesPerTeam,
      autoApply,
    };
    setConfig(league.id, config);
    onClose();
  };

  const handleSaveAndRun = () => {
    const config: LeagueAutoLinkConfig = {
      matchMode,
      sourceIds: selectedSourceIds,
      categoryIds: selectedCategoryIds,
      minConfidence,
      maxCandidatesPerTeam,
      autoApply,
    };
    setConfig(league.id, config);
    onClose();
    if (onSaveAndRun) {
      onSaveAndRun(config);
    }
  };

  const hasActiveSearch = categorySearch.trim().length > 0;

  if (!isOpen) return null;

  return createPortal(
    <div className="als-overlay" onClick={onClose}>
      <div className="als-modal" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="als-header">
          <div className="als-header-info">
            <div className="als-header-title-row">
              <span className="als-header-icon">⚙</span>
              <h2 className="als-title">
                {t('sports:autoLinkSettings')}: <span className="als-league-name">{league.name}</span>
              </h2>
            </div>
            <p className="als-subtitle">
              {t('sports:autoLinkSettingsSubtitle', { league: league.name })}
            </p>
          </div>
          <button className="als-close-btn" onClick={onClose} aria-label={t('common:close')}>
            ✕
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="als-nav-tabs">
          <button
            className={`als-nav-tab ${activeTab === 'strategy' ? 'active' : ''}`}
            onClick={() => setActiveTab('strategy')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <circle cx="12" cy="12" r="10" />
              <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
            </svg>
            <span>{t('sports:matchStrategy')}</span>
            <span className="als-badge-pill">{matchMode.toUpperCase()}</span>
          </button>

          <button
            className={`als-nav-tab ${activeTab === 'sources' ? 'active' : ''}`}
            onClick={() => setActiveTab('sources')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span>{t('sports:sourceScope')}</span>
            <span className="als-badge-pill">
              {selectedSourceIds.length === 0 ? t('sports:allSources') : `${selectedSourceIds.length}`}
            </span>
          </button>

          <button
            className={`als-nav-tab ${activeTab === 'categories' ? 'active' : ''}`}
            onClick={() => setActiveTab('categories')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span>{t('sports:categoryScope')}</span>
            <span className="als-badge-pill">
              {selectedCategoryIds.length === 0 ? t('sports:allCategories') : `${selectedCategoryIds.length}`}
            </span>
          </button>
        </div>

        {/* Content Body */}
        <div className="als-content-body tcs-custom-scrollbar">
          {/* TAB 1: MATCHING STRATEGY & RESULTS THRESHOLDS */}
          {activeTab === 'strategy' && (
            <div className="als-section">
              <div className="als-section-header">
                <h3>{t('sports:matchStrategy')}</h3>
                <p>{t('sports:matchStrategyDesc')}</p>
              </div>

              <div className="als-radio-group">
                {/* Mode 1: Full City + Team */}
                <label className={`als-radio-card ${matchMode === 'full' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="matchMode"
                    value="full"
                    checked={matchMode === 'full'}
                    onChange={() => setMatchMode('full')}
                  />
                  <div className="als-radio-content">
                    <div className="als-radio-title-row">
                      <span className="als-radio-title">{t('sports:matchModeFull')}</span>
                      <span className="als-chip-tag recommended">{t('sports:matchModeFullTag')}</span>
                    </div>
                    <p className="als-radio-desc">{t('sports:matchModeFullDesc')}</p>
                  </div>
                </label>

                {/* Mode 2: Smart Match */}
                <label className={`als-radio-card ${matchMode === 'both' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="matchMode"
                    value="both"
                    checked={matchMode === 'both'}
                    onChange={() => setMatchMode('both')}
                  />
                  <div className="als-radio-content">
                    <div className="als-radio-title-row">
                      <span className="als-radio-title">{t('sports:matchModeBoth')}</span>
                      <span className="als-chip-tag default">{t('sports:matchModeBothTag')}</span>
                    </div>
                    <p className="als-radio-desc">{t('sports:matchModeBothDesc')}</p>
                  </div>
                </label>

                {/* Mode 3: Nickname Only */}
                <label className={`als-radio-card ${matchMode === 'nickname' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="matchMode"
                    value="nickname"
                    checked={matchMode === 'nickname'}
                    onChange={() => setMatchMode('nickname')}
                  />
                  <div className="als-radio-content">
                    <div className="als-radio-title-row">
                      <span className="als-radio-title">{t('sports:matchModeNickname')}</span>
                      <span className="als-chip-tag relaxed">{t('sports:matchModeNicknameTag')}</span>
                    </div>
                    <p className="als-radio-desc">{t('sports:matchModeNicknameDesc')}</p>
                  </div>
                </label>
              </div>

              {/* Confidence & Results Options */}
              <div className="als-section-header" style={{ marginTop: 8 }}>
                <h3>{t('sports:confidenceResults')}</h3>
                <p>{t('sports:confidenceResultsDesc')}</p>
              </div>

              <div className="als-settings-grid-2col">
                <div className="als-setting-box">
                  <label className="als-setting-label">{t('sports:minConfidence')}:</label>
                  <select
                    className="als-select-control"
                    value={minConfidence}
                    onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
                  >
                    <option value={0.5}>{t('sports:confidenceOption50')}</option>
                    <option value={0.6}>{t('sports:confidenceOption60')}</option>
                    <option value={0.7}>{t('sports:confidenceOption70')}</option>
                    <option value={0.8}>{t('sports:confidenceOption80')}</option>
                    <option value={0.9}>{t('sports:confidenceOption90')}</option>
                  </select>
                  <span className="als-setting-hint">{t('sports:minConfidenceHint')}</span>
                </div>

                <div className="als-setting-box">
                  <label className="als-setting-label">{t('sports:channelsPerTeam')}:</label>
                  <select
                    className="als-select-control"
                    value={maxCandidatesPerTeam}
                    onChange={(e) => setMaxCandidatesPerTeam(parseInt(e.target.value, 10))}
                  >
                    <option value={1}>{t('sports:candidatesPerTeam1')}</option>
                    <option value={2}>{t('sports:candidatesPerTeam2')}</option>
                    <option value={3}>{t('sports:candidatesPerTeam3')}</option>
                    <option value={5}>{t('sports:candidatesPerTeam5')}</option>
                  </select>
                  <span className="als-setting-hint">{t('sports:channelsPerTeamHint')}</span>
                </div>
              </div>

              <div className="als-setting-box" style={{ marginTop: 4 }}>
                <label className="als-toggle-row">
                  <input
                    type="checkbox"
                    checked={!autoApply}
                    onChange={(e) => setAutoApply(!e.target.checked)}
                  />
                  <span className="als-checkbox-custom" />
                  <div className="als-toggle-label">
                    <span className="als-toggle-title">{t('sports:showSuggestionsForReview')}</span>
                    <span className="als-toggle-desc">
                      {t('sports:showSuggestionsForReviewDesc')}
                    </span>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* TAB 2: SOURCES SCOPE */}
          {activeTab === 'sources' && (
            <div className="als-section">
              <div className="als-section-header">
                <h3>{t('sports:sourceScope')}</h3>
                <p>{t('sports:sourceScopeDesc')}</p>
              </div>

              <div className="als-filter-toolbar">
                <button
                  className={`als-btn-mini ${selectedSourceIds.length === 0 ? 'active' : ''}`}
                  onClick={handleSelectAllSources}
                >
                  {t('sports:allSources')}
                </button>
                <span className="als-toolbar-count">
                  {selectedSourceIds.length === 0
                    ? t('sports:searchingAllSources', { count: sources.length })
                    : t('sports:sourcesSelected', { selected: selectedSourceIds.length, total: sources.length })}
                </span>
              </div>

              <div className="als-checkbox-grid">
                {sources.map((s) => {
                  const isChecked =
                    selectedSourceIds.length === 0 || selectedSourceIds.includes(s.id);
                  return (
                    <label
                      key={s.id}
                      className={`als-checkbox-card ${isChecked ? 'checked' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedSourceIds.includes(s.id)}
                        onChange={() => handleToggleSource(s.id)}
                      />
                      <span className="als-checkbox-custom" />
                      <div className="als-checkbox-label">
                        <span className="als-source-name">{s.name}</span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: CATEGORIES SCOPE */}
          {activeTab === 'categories' && (
            <div className="als-section">
              <div className="als-section-header">
                <h3>{t('sports:categoryScope')}</h3>
                <p>{t('sports:categoryScopeDesc')}</p>
              </div>

              <div className="als-category-controls">
                <div className="als-search-wrap">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    className="als-search-input"
                    placeholder={t('sports:searchCategories')}
                    value={categorySearch}
                    onChange={(e) => setCategorySearch(e.target.value)}
                  />
                  {categorySearch && (
                    <button className="als-search-clear" onClick={() => setCategorySearch('')}>
                      ✕
                    </button>
                  )}
                </div>

                <div className="als-category-preset-strip">
                  {hasActiveSearch && filteredCategories.length > 0 ? (
                    <>
                      <button
                        className="als-btn-mini highlight"
                        onClick={handleSelectMatchingCategories}
                      >
                        ✓ {t('sports:selectMatching', { count: filteredCategories.length })}
                      </button>
                      <button
                        className="als-btn-mini"
                        onClick={handleDeselectMatchingCategories}
                      >
                        ✕ {t('sports:deselectMatching')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className={`als-btn-mini ${selectedCategoryIds.length === 0 ? 'active' : ''}`}
                        onClick={handleSelectAllCategories}
                      >
                        {t('sports:allCategories')}
                      </button>
                      <button
                        className="als-btn-mini highlight"
                        onClick={handleSelectSportsCategoriesOnly}
                      >
                        ⚡ {t('sports:sportsOnly')}
                      </button>
                      {selectedCategoryIds.length > 0 && (
                        <button className="als-btn-mini" onClick={handleClearCategories}>
                          {t('sports:clearCount', { count: selectedCategoryIds.length })}
                        </button>
                      )}
                    </>
                  )}

                  <div className="als-expand-collapse-group">
                    <button className="als-btn-mini-link" onClick={handleExpandAllSources}>
                      {t('sports:expandAll')}
                    </button>
                    <span className="als-divider-dot">•</span>
                    <button className="als-btn-mini-link" onClick={handleCollapseAllSources}>
                      {t('sports:collapseAll')}
                    </button>
                  </div>
                </div>
              </div>

              <div className="als-category-count-bar">
                <span>
                  {selectedCategoryIds.length === 0
                    ? t('sports:searchingAllCategories', { count: categories.length })
                    : t('sports:categoriesSelected', { count: selectedCategoryIds.length })}
                </span>
                <span className="als-showing-count">
                  {t('sports:categoriesInSources', { categories: filteredCategories.length, sources: categoriesBySource.length })}
                </span>
              </div>

              <div className="als-categories-list">
                {categoriesBySource.length === 0 ? (
                  <div className="als-empty-state">
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
                        className={`als-source-category-group ${isExpanded ? 'is-expanded' : ''}`}
                      >
                        <div
                          className="als-source-group-header"
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
                          <div className="als-source-group-left">
                            <span className={`als-source-chevron ${isExpanded ? 'expanded' : ''}`}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="9 18 15 12 9 6" />
                              </svg>
                            </span>
                            <label
                              className="als-source-group-checkbox"
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
                            <span className="als-source-group-title">{group.sourceName}</span>
                            <span className="als-source-total-count">({group.categories.length})</span>
                          </div>

                          <div className="als-source-group-right">
                            <span className={`als-source-group-badge ${groupSelectedCount > 0 ? 'active' : ''}`}>
                              {groupSelectedCount > 0
                                ? t('sports:selectedOutOf', { selected: groupSelectedCount, total: group.categories.length })
                                : t('sports:categoryCount', { count: group.categories.length })}
                            </span>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="als-source-group-items">
                            {group.categories.map((c) => {
                              const isSelected = selectedCategoryIds.includes(c.id);
                              return (
                                <label
                                  key={`${c.source_id || ''}:${c.id}`}
                                  className={`als-category-row ${isSelected ? 'selected' : ''}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => handleToggleCategory(c.id)}
                                  />
                                  <span className="als-checkbox-custom" />
                                  <div className="als-category-row-info">
                                    <span className="als-cat-name">{c.name}</span>
                                  </div>
                                  {c.channel_count !== undefined && c.channel_count > 0 && (
                                    <span className="als-cat-count">{t('sports:channelCountShort', { count: c.channel_count })}</span>
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
        <div className="als-footer">
          <button className="als-btn-reset" onClick={handleReset} title={t('sports:resetLeagueSettings')}>
            {t('sports:resetLeagueSettings')}
          </button>
          <div className="als-footer-right">
            <button className="als-btn-cancel" onClick={onClose}>
              {t('common:cancel')}
            </button>
            <button className="als-btn-save" onClick={handleSave}>
              {t('common:save')}
            </button>
            {onSaveAndRun && (
              <button className="als-btn-save-run" onClick={handleSaveAndRun}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
                </svg>
                <span>{t('sports:saveAndAutoLink')}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
