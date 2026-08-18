import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { db, type StoredCategory } from '../db';
import {
  clusterChannelsIntoFailoverGroups,
  type FailoverMatchConfig,
  type ProposedFailoverGroup,
  type ExistingGroupAddition,
} from '../services/failoverMatcher';
import {
  createFailoverGroupsBatch,
  addChannelsToFailoverGroupBatch,
} from '../services/failover-groups';
import './FailoverAutoClusterModal.css';

interface FailoverAutoClusterModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const COMMON_COUNTRIES = ['US', 'CA', 'UK', 'AU', 'ES', 'LATIN', 'DE', 'FR', 'IT', 'NZ', 'IE', 'MX', 'BR'];

/* ── SVG Icons ── */
function ZapSvg({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} style={{ flexShrink: 0 }}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function SettingsSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function AntennaSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M2 12h20" />
      <path d="M7 12a5 5 0 0 1 10 0" />
      <path d="M12 2v20" />
      <path d="M12 2a4 4 0 0 1 4 4" />
      <path d="M12 2a4 4 0 0 0-4 4" />
    </svg>
  );
}

function FolderSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function SparklesSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
    </svg>
  );
}

function TargetSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

function ClockSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function StarSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function LinkSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function LockSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function GlobeSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function CheckSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CrossSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function RefreshSvg({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'facSpin 1.2s linear infinite', flexShrink: 0 }}>
      <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
    </svg>
  );
}

function TvSvg({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect width="20" height="15" x="2" y="7" rx="2" ry="2" />
      <polyline points="17 2 12 7 7 2" />
    </svg>
  );
}

function PlusSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function FailoverAutoClusterModal({
  isOpen,
  onClose,
  onSuccess,
}: FailoverAutoClusterModalProps) {
  useTranslation('settings');
  const [activeTab, setActiveTab] = useState<'strategy' | 'sources' | 'categories' | 'results'>('strategy');

  // Config State
  const [minConfidence, setMinConfidence] = useState<number>(0.8);
  const [groupQualityVariants, setGroupQualityVariants] = useState<boolean>(true);
  const [matchByCallsign, setMatchByCallsign] = useState<boolean>(true);
  const [feedMode, setFeedMode] = useState<'merge_neutral_east' | 'combine_all' | 'strict_separate'>('merge_neutral_east');
  const [stripCountryPrefixes, setStripCountryPrefixes] = useState<boolean>(true);
  const [countryMode, setCountryMode] = useState<'same_only' | 'acceptable_set' | 'any'>('same_only');
  const [acceptableCountries, setAcceptableCountries] = useState<string[]>(['US', 'CA']);
  const [customCountriesText, setCustomCountriesText] = useState<string>('US, CA');

  // Scope State
  const [sources, setSources] = useState<Array<{ id: string; name: string }>>([]);
  const [categories, setCategories] = useState<StoredCategory[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [categorySearch, setCategorySearch] = useState('');
  const [expandedSourceIds, setExpandedSourceIds] = useState<Set<string>>(new Set());

  // Scanning & Results State
  const [isScanning, setIsScanning] = useState(false);
  const [proposedGroups, setProposedGroups] = useState<ProposedFailoverGroup[]>([]);
  const [existingAdditions, setExistingAdditions] = useState<ExistingGroupAddition[]>([]);
  const [acceptedGroupKeys, setAcceptedGroupKeys] = useState<Set<string>>(new Set());
  const [acceptedAdditionGroupIds, setAcceptedAdditionGroupIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load enabled sources & categories
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    async function loadData() {
      try {
        const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
        const enabledSources = (sourcesResult.data || []).filter((s: any) => s.enabled !== false && s.name && s.name.trim() !== '');
        const enabledSourceIds = new Set(enabledSources.map((s: any) => String(s.id)));

        const allCategories = await db.categories.toArray();
        const enabledCats = allCategories.filter(
          (c) => enabledSourceIds.has(String(c.source_id)) && c.enabled !== false
        );

        if (isMounted) {
          setSources(enabledSources);
          setCategories(enabledCats);
          setExpandedSourceIds(new Set()); // Collapsed by default
        }
      } catch (e) {
        console.error('[FailoverAutoClusterModal] Failed to load sources/categories:', e);
      }
    }

    loadData();
    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Fast Source Name Map for results badges
  const sourceNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) {
      map.set(String(s.id), s.name);
    }
    return map;
  }, [sources]);

  // Scope: Sources & Categories
  const toggleSource = (sourceId: string) => {
    setSelectedSourceIds((prev) =>
      prev.includes(sourceId) ? prev.filter((id) => id !== sourceId) : [...prev, sourceId]
    );
  };

  const isAllCategoriesMode = selectedCategoryIds.length === 0;

  const handleSelectAllCategories = () => {
    setSelectedCategoryIds([]);
  };

  const handleClearCategories = () => {
    setSelectedCategoryIds(['__NONE__']);
  };

  const toggleSourceAccordion = (sourceId: string) => {
    setExpandedSourceIds((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };

  const handleExpandAllSources = () => {
    setExpandedSourceIds(new Set(sources.map((s) => String(s.id))));
  };

  const handleCollapseAllSources = () => {
    setExpandedSourceIds(new Set());
  };

  const handleToggleCategory = (catIdStr: string) => {
    if (isAllCategoriesMode) {
      const allIds = categories.map((c) => String(c.category_id));
      setSelectedCategoryIds(allIds.filter((id) => id !== catIdStr));
      return;
    }

    setSelectedCategoryIds((prev) => {
      const cleaned = prev.filter((id) => id !== '__NONE__');
      if (cleaned.includes(catIdStr)) {
        const next = cleaned.filter((id) => id !== catIdStr);
        return next.length === 0 ? ['__NONE__'] : next;
      } else {
        return [...cleaned, catIdStr];
      }
    });
  };

  const handleToggleSourceCategories = (sourceId: string, groupCatIds: string[]) => {
    if (isAllCategoriesMode) {
      const allIds = categories.map((c) => String(c.category_id));
      const groupSet = new Set(groupCatIds);
      const next = allIds.filter((id) => !groupSet.has(id));
      setSelectedCategoryIds(next.length === 0 ? ['__NONE__'] : next);
      return;
    }

    const cleaned = selectedCategoryIds.filter((id) => id !== '__NONE__');
    const allSelected = groupCatIds.every((id) => cleaned.includes(id));

    if (allSelected) {
      const groupSet = new Set(groupCatIds);
      const next = cleaned.filter((id) => !groupSet.has(id));
      setSelectedCategoryIds(next.length === 0 ? ['__NONE__'] : next);
    } else {
      const nextSet = new Set([...cleaned, ...groupCatIds]);
      setSelectedCategoryIds(Array.from(nextSet));
    }
  };

  // Grouped Categories with Live Search
  const { categoriesBySource, filteredCategories } = useMemo(() => {
    const effectiveSources = selectedSourceIds.length > 0
      ? sources.filter((s) => selectedSourceIds.includes(String(s.id)))
      : sources;

    const sourceMap = new Map<string, string>();
    for (const s of effectiveSources) {
      sourceMap.set(String(s.id), s.name);
    }

    const filtered = categories.filter((c) => {
      const sId = String(c.source_id);
      if (!sourceMap.has(sId)) return false;
      if (!categorySearch.trim()) return true;
      const q = categorySearch.toLowerCase();
      return (
        (c.category_name || '').toLowerCase().includes(q) ||
        (sourceMap.get(sId) || '').toLowerCase().includes(q)
      );
    });

    const groupsMap = new Map<string, StoredCategory[]>();
    for (const cat of filtered) {
      const sId = String(cat.source_id);
      if (!groupsMap.has(sId)) {
        groupsMap.set(sId, []);
      }
      groupsMap.get(sId)!.push(cat);
    }

    const result = [];
    for (const s of effectiveSources) {
      const sId = String(s.id);
      const catsInGroup = groupsMap.get(sId) || [];
      if (catsInGroup.length > 0) {
        result.push({
          sourceId: sId,
          sourceName: s.name,
          categories: catsInGroup,
        });
      }
    }

    return { categoriesBySource: result, filteredCategories: filtered };
  }, [sources, categories, selectedSourceIds, categorySearch]);

  // Auto-expand search results
  useEffect(() => {
    if (categorySearch.trim()) {
      setExpandedSourceIds(new Set(categoriesBySource.map((g) => g.sourceId)));
    }
  }, [categorySearch, categoriesBySource]);

  // Parse comma-separated country codes
  const parseCountryInput = (val: string): string[] => {
    return val
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  };

  const handleCustomCountriesInputChange = (val: string) => {
    setCustomCountriesText(val);
    const parsed = parseCountryInput(val);
    setAcceptableCountries(parsed);
  };

  const toggleCountry = (country: string) => {
    setAcceptableCountries((prev) => {
      let next: string[];
      if (prev.includes(country)) {
        next = prev.filter((c) => c !== country);
      } else {
        next = [...prev, country];
      }
      setCustomCountriesText(next.join(', '));
      return next;
    });
  };

  // Run Smart Clustering Scan
  const handleRunScan = useCallback(async () => {
    setIsScanning(true);
    setActiveTab('results');
    try {
      const config: FailoverMatchConfig = {
        minConfidence,
        groupQualityVariants,
        matchByCallsign,
        feedMode,
        stripCountryPrefixes,
        countryMode,
        acceptableCountries,
        sourceIds: selectedSourceIds.length > 0 ? selectedSourceIds : undefined,
        categoryIds:
          selectedCategoryIds.length > 0 && !selectedCategoryIds.includes('__NONE__')
            ? selectedCategoryIds
            : undefined,
      };

      const result = await clusterChannelsIntoFailoverGroups(config);
      setProposedGroups(result.proposedGroups);
      setExistingAdditions(result.existingAdditions);
      setAcceptedGroupKeys(new Set());
      setAcceptedAdditionGroupIds(new Set());
      setSaveError(null);
    } catch (e) {
      console.error('[FailoverAutoClusterModal] Scan failed:', e);
    } finally {
      setIsScanning(false);
    }
  }, [
    minConfidence,
    groupQualityVariants,
    matchByCallsign,
    feedMode,
    stripCountryPrefixes,
    countryMode,
    acceptableCountries,
    selectedSourceIds,
    selectedCategoryIds,
  ]);

  // Accept a single proposed group
  const handleAcceptGroup = async (group: ProposedFailoverGroup) => {
    setSaving(true);
    setSaveError(null);
    try {
      await createFailoverGroupsBatch([
        {
          name: group.name,
          streamIds: group.channels.map((c) => c.stream_id),
        },
      ]);
      setAcceptedGroupKeys((prev) => new Set([...prev, group.key]));
      onSuccess?.();
    } catch (e: any) {
      console.error('Failed to create group:', e);
      setSaveError(e?.message || i18n.t('settings:failover.failedToSave', { defaultValue: 'Could not save the changes. Please try again.' }));
    } finally {
      setSaving(false);
    }
  };

  // Accept additions for an existing group
  const handleAcceptAddition = async (addition: ExistingGroupAddition) => {
    setSaving(true);
    setSaveError(null);
    try {
      await addChannelsToFailoverGroupBatch(
        addition.groupId,
        addition.candidates.map((c) => c.channel.stream_id)
      );
      setAcceptedAdditionGroupIds((prev) => new Set([...prev, addition.groupId]));
      onSuccess?.();
    } catch (e: any) {
      console.error('Failed to add to group:', e);
      setSaveError(e?.message || i18n.t('settings:failover.failedToSave', { defaultValue: 'Could not save the changes. Please try again.' }));
    } finally {
      setSaving(false);
    }
  };

  // Accept All proposed groups
  const handleAcceptAll = async () => {
    const pendingGroups = proposedGroups.filter((g) => !acceptedGroupKeys.has(g.key));
    if (pendingGroups.length === 0) return;

    setSaving(true);
    setSaveError(null);
    try {
      const batchPayload = pendingGroups.map((g) => ({
        name: g.name,
        streamIds: g.channels.map((c) => c.stream_id),
      }));
      await createFailoverGroupsBatch(batchPayload);

      const allKeys = new Set(proposedGroups.map((g) => g.key));
      setAcceptedGroupKeys(allKeys);
      onSuccess?.();
    } catch (e: any) {
      console.error('Failed to accept all groups:', e);
      setSaveError(e?.message || i18n.t('settings:failover.failedToSave', { defaultValue: 'Could not save the changes. Please try again.' }));
    } finally {
      setSaving(false);
    }
  };

  // Dismiss a proposed group from results
  const handleDismissGroup = (key: string) => {
    setProposedGroups((prev) => prev.filter((g) => g.key !== key));
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fac-overlay">
      <div className="fac-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="fac-header">
          <div className="fac-header-left">
            <span className="fac-header-icon"><ZapSvg size={20} /></span>
            <h2>{i18n.t('settings:failover.autoClusterTitle', { defaultValue: 'Smart Failover Group Clustering' })}</h2>
          </div>
          <button className="fac-close-btn" onClick={onClose} title={i18n.t('common:close', { defaultValue: 'Close' })}>
            <CrossSvg size={16} />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="fac-nav-tabs">
          <button
            className={`fac-tab-btn ${activeTab === 'strategy' ? 'active' : ''}`}
            onClick={() => setActiveTab('strategy')}
          >
            <SettingsSvg size={15} />
            <span>{i18n.t('settings:failover.tabStrategy', { defaultValue: 'Matching Rules' })}</span>
          </button>
          <button
            className={`fac-tab-btn ${activeTab === 'sources' ? 'active' : ''}`}
            onClick={() => setActiveTab('sources')}
          >
            <AntennaSvg size={15} />
            <span>{i18n.t('settings:failover.tabSources', { defaultValue: 'Sources' })}</span>
            {selectedSourceIds.length > 0 && (
              <span className="fac-tab-badge">{selectedSourceIds.length}</span>
            )}
          </button>
          <button
            className={`fac-tab-btn ${activeTab === 'categories' ? 'active' : ''}`}
            onClick={() => setActiveTab('categories')}
          >
            <FolderSvg size={15} />
            <span>{i18n.t('settings:failover.tabCategories', { defaultValue: 'Categories' })}</span>
            {selectedCategoryIds.length > 0 && (
              <span className="fac-tab-badge">{selectedCategoryIds.length}</span>
            )}
          </button>
          {(proposedGroups.length > 0 || existingAdditions.length > 0 || isScanning) && (
            <button
              className={`fac-tab-btn ${activeTab === 'results' ? 'active' : ''}`}
              onClick={() => setActiveTab('results')}
            >
              <SparklesSvg size={15} />
              <span>{i18n.t('settings:failover.tabSuggestions', { defaultValue: 'Suggested Groups' })}</span>
              <span className="fac-tab-badge">
                {proposedGroups.length + existingAdditions.length}
              </span>
            </button>
          )}
        </div>

        {/* Body */}
        <div className="fac-body">
          {/* TAB 1: Matching Rules & Countries */}
          {activeTab === 'strategy' && (
            <>
              <div className="fac-section">
                <div className="fac-section-title">
                  <TargetSvg size={16} />
                  <span>{i18n.t('settings:failover.matchingOptions', { defaultValue: 'Smart Matching Options' })}</span>
                </div>

                <div className="fac-setting-row">
                  <div className="fac-setting-label">
                    <span className="fac-setting-title">{i18n.t('settings:failover.stripCountryPrefixes', { defaultValue: 'Strip Country & Provider Prefixes' })}</span>
                    <span className="fac-setting-desc">{i18n.t('settings:failover.stripCountryPrefixesDesc', { defaultValue: 'Ignore formatting prefixes like US | , USA:, [US], (US), UK: so differing provider names match accurately' })}</span>
                  </div>
                  <label className="fac-checkbox-label">
                    <input
                      type="checkbox"
                      checked={stripCountryPrefixes}
                      onChange={(e) => setStripCountryPrefixes(e.target.checked)}
                    />
                  </label>
                </div>

                <div className="fac-setting-row">
                  <div className="fac-setting-label">
                    <span className="fac-setting-title">{i18n.t('settings:failover.groupQuality', { defaultValue: 'Group Quality Variants' })}</span>
                    <span className="fac-setting-desc">{i18n.t('settings:failover.groupQualityDesc', { defaultValue: 'Cluster 4K, FHD, HD, and SD versions of the same channel and rank by quality' })}</span>
                  </div>
                  <label className="fac-checkbox-label">
                    <input
                      type="checkbox"
                      checked={groupQualityVariants}
                      onChange={(e) => setGroupQualityVariants(e.target.checked)}
                    />
                  </label>
                </div>

                <div className="fac-setting-row">
                  <div className="fac-setting-label">
                    <span className="fac-setting-title">{i18n.t('settings:failover.matchCallsign', { defaultValue: 'Match Local Stations by Callsign' })}</span>
                    <span className="fac-setting-desc">{i18n.t('settings:failover.matchCallsignDesc', { defaultValue: 'Cluster affiliate channels sharing the same broadcast callsign (WABC, KNBC, etc.)' })}</span>
                  </div>
                  <label className="fac-checkbox-label">
                    <input
                      type="checkbox"
                      checked={matchByCallsign}
                      onChange={(e) => setMatchByCallsign(e.target.checked)}
                    />
                  </label>
                </div>

                <div className="fac-setting-row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: '8px' }}>
                  <div className="fac-setting-label">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <ClockSvg size={14} />
                      <span className="fac-setting-title">{i18n.t('settings:failover.feedAlignment', { defaultValue: 'East / West Feed Alignment' })}</span>
                    </div>
                    <span className="fac-setting-desc">{i18n.t('settings:failover.feedAlignmentDesc', { defaultValue: 'Control how unlabeled channels without East/West in their name are matched with explicit feeds' })}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', width: '100%', marginTop: '4px' }}>
                    <button
                      className={`fac-btn-secondary ${feedMode === 'merge_neutral_east' ? 'active' : ''}`}
                      style={{
                        background: feedMode === 'merge_neutral_east' ? 'rgba(0, 212, 255, 0.2)' : undefined,
                        borderColor: feedMode === 'merge_neutral_east' ? 'var(--accent-primary, #00d4ff)' : undefined,
                        color: feedMode === 'merge_neutral_east' ? '#fff' : undefined,
                        fontSize: '0.8rem',
                        padding: '6px 12px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                      onClick={() => setFeedMode('merge_neutral_east')}
                      title={i18n.t('settings:failover.feedCombineEastTitle', { defaultValue: 'Unlabeled channels (e.g. A&E) combine with East feeds, while West feeds remain separate' })}
                    >
                      <StarSvg size={13} />
                      <span>{i18n.t('settings:failover.mergeNeutralEast', { defaultValue: 'Merge Default with East (Recommended)' })}</span>
                    </button>

                    <button
                      className={`fac-btn-secondary ${feedMode === 'combine_all' ? 'active' : ''}`}
                      style={{
                        background: feedMode === 'combine_all' ? 'rgba(0, 212, 255, 0.2)' : undefined,
                        borderColor: feedMode === 'combine_all' ? 'var(--accent-primary, #00d4ff)' : undefined,
                        color: feedMode === 'combine_all' ? '#fff' : undefined,
                        fontSize: '0.8rem',
                        padding: '6px 12px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                      onClick={() => setFeedMode('combine_all')}
                      title={i18n.t('settings:failover.feedCombineAllTitle', { defaultValue: 'Combine all East, West, and unlabeled streams into one single failover group' })}
                    >
                      <LinkSvg size={13} />
                      <span>{i18n.t('settings:failover.combineAllFeeds', { defaultValue: 'Combine All (East, West & Default)' })}</span>
                    </button>

                    <button
                      className={`fac-btn-secondary ${feedMode === 'strict_separate' ? 'active' : ''}`}
                      style={{
                        background: feedMode === 'strict_separate' ? 'rgba(0, 212, 255, 0.2)' : undefined,
                        borderColor: feedMode === 'strict_separate' ? 'var(--accent-primary, #00d4ff)' : undefined,
                        color: feedMode === 'strict_separate' ? '#fff' : undefined,
                        fontSize: '0.8rem',
                        padding: '6px 12px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                      onClick={() => setFeedMode('strict_separate')}
                      title={i18n.t('settings:failover.feedStrictSeparateTitle', { defaultValue: 'Keep East, West, and unlabeled feeds strictly separated in different groups' })}
                    >
                      <LockSvg size={13} />
                      <span>{i18n.t('settings:failover.strictSeparateFeeds', { defaultValue: 'Strict Separate' })}</span>
                    </button>
                  </div>
                </div>

                <div className="fac-setting-row">
                  <div className="fac-setting-label">
                    <span className="fac-setting-title">{i18n.t('settings:failover.minConfidence', { defaultValue: 'Minimum Confidence Score' })}</span>
                    <span className="fac-setting-desc">{i18n.t('settings:failover.minConfidenceDesc', { defaultValue: 'Higher thresholds ensure stricter similarity before proposing a failover group' })}</span>
                  </div>
                  <div className="fac-slider-wrap">
                    <input
                      type="range"
                      min="0.5"
                      max="1.0"
                      step="0.05"
                      value={minConfidence}
                      onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
                    />
                    <span className="fac-slider-val">{Math.round(minConfidence * 100)}%</span>
                  </div>
                </div>
              </div>

              {/* Country Linking Section */}
              <div className="fac-section">
                <div className="fac-section-title">
                  <GlobeSvg size={16} />
                  <span>{i18n.t('settings:failover.countryRules', { defaultValue: 'Country & Regional Linking' })}</span>
                </div>

                <div className="fac-setting-row">
                  <div className="fac-setting-label">
                    <span className="fac-setting-title">{i18n.t('settings:failover.countryPolicy', { defaultValue: 'Country Policy' })}</span>
                    <span className="fac-setting-desc">{i18n.t('settings:failover.countryPolicyDesc', { defaultValue: 'Prevent channels from differing countries from linking unless allowed' })}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className={`fac-btn-secondary ${countryMode === 'same_only' ? 'active' : ''}`}
                      style={{
                        background: countryMode === 'same_only' ? 'rgba(0, 212, 255, 0.2)' : undefined,
                        borderColor: countryMode === 'same_only' ? 'var(--accent-primary, #00d4ff)' : undefined,
                        color: countryMode === 'same_only' ? '#fff' : undefined,
                      }}
                      onClick={() => setCountryMode('same_only')}
                    >
                      {i18n.t('settings:failover.sameCountryOnly', { defaultValue: 'Same Country Only' })}
                    </button>
                    <button
                      className={`fac-btn-secondary ${countryMode === 'acceptable_set' ? 'active' : ''}`}
                      style={{
                        background: countryMode === 'acceptable_set' ? 'rgba(0, 212, 255, 0.2)' : undefined,
                        borderColor: countryMode === 'acceptable_set' ? 'var(--accent-primary, #00d4ff)' : undefined,
                        color: countryMode === 'acceptable_set' ? '#fff' : undefined,
                      }}
                      onClick={() => setCountryMode('acceptable_set')}
                    >
                      {i18n.t('settings:failover.allowedCountrySet', { defaultValue: 'Allowed Countries' })}
                    </button>
                  </div>
                </div>

                {countryMode === 'acceptable_set' && (
                  <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {/* User Editable Comma-Separated Country Codes Input */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.85)', fontWeight: 500 }}>
                        {i18n.t('settings:failover.allowedCountriesInput', { defaultValue: 'Allowed Country Codes (comma-separated):' })}
                      </div>
                      <input
                        type="text"
                        className="fac-search-input"
                        style={{
                          width: '100%',
                          padding: '8px 12px',
                          borderRadius: '6px',
                          fontSize: '0.85rem',
                          background: 'rgba(0, 0, 0, 0.35)',
                          border: '1px solid rgba(255, 255, 255, 0.15)',
                          color: '#fff',
                        }}
                        placeholder={i18n.t('settings:failover.countryCodesPlaceholder', { defaultValue: 'e.g. US, CA, UK, AU, MX, ES, LATIN' })}
                        value={customCountriesText}
                        onChange={(e) => handleCustomCountriesInputChange(e.target.value)}
                      />
                      <span style={{ fontSize: '0.72rem', color: 'rgba(255, 255, 255, 0.45)' }}>
                        {i18n.t('settings:failover.allowedCountriesHint', { defaultValue: 'Type any custom country codes or click the quick presets below to toggle.' })}
                      </span>
                    </div>

                    {/* Quick Presets Chips */}
                    <div>
                      <div style={{ fontSize: '0.76rem', color: 'rgba(255, 255, 255, 0.6)', marginBottom: '6px' }}>
                        {i18n.t('settings:failover.quickSelectPresets', { defaultValue: 'Quick Presets:' })}
                      </div>
                      <div className="fac-country-chips">
                        {COMMON_COUNTRIES.map((c) => {
                          const isSelected = acceptableCountries.includes(c);
                          return (
                            <button
                              key={c}
                              className={`fac-country-chip ${isSelected ? 'selected' : ''}`}
                              onClick={() => toggleCountry(c)}
                            >
                              {isSelected && <CheckSvg size={12} />}
                              <span>{c}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* TAB 2: Sources Scope */}
          {activeTab === 'sources' && (
            <div className="fac-section">
              <div className="fac-section-title" style={{ justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <AntennaSvg size={16} />
                  <span>{i18n.t('settings:failover.scopeSources', { defaultValue: 'Enabled Sources Scope' })}</span>
                </div>
                <button
                  className="fac-btn-secondary"
                  style={{ padding: '4px 10px', fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                  onClick={() => setSelectedSourceIds([])}
                >
                  {selectedSourceIds.length === 0 ? (
                    <>
                      <CheckSvg size={12} />
                      <span>{i18n.t('settings:failover.allSources', { defaultValue: 'All Sources' })}</span>
                    </>
                  ) : (
                    <span>{i18n.t('settings:failover.selectAll', { defaultValue: 'Select All' })}</span>
                  )}
                </button>
              </div>
              <p style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)', margin: '0 0 12px 0' }}>
                {i18n.t('settings:failover.sourcesScopeDesc', { defaultValue: 'Leave all unselected to scan across all enabled sources, or check specific sources to narrow clustering.' })}
              </p>
              <div className="fac-scope-grid">
                {sources.map((s) => {
                  const isChecked = selectedSourceIds.length === 0 || selectedSourceIds.includes(String(s.id));
                  return (
                    <label key={s.id} className={`fac-scope-item ${isChecked ? 'is-selected' : ''}`}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSource(String(s.id))}
                      />
                      <span>{s.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: Categories Scope (Grouped by Source Accordion) */}
          {activeTab === 'categories' && (
            <div className="fac-section">
              <div className="fac-section-title" style={{ justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <FolderSvg size={16} />
                  <span>{i18n.t('settings:failover.scopeCategories', { defaultValue: 'Categories Scope' })}</span>
                </div>
              </div>

              {/* Controls Toolbar */}
              <div className="fac-category-controls">
                <div className="fac-search-wrap">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    className="fac-search-input"
                    placeholder={i18n.t('settings:failover.searchCategories', { defaultValue: 'Search categories...' })}
                    value={categorySearch}
                    onChange={(e) => setCategorySearch(e.target.value)}
                  />
                  {categorySearch && (
                    <button className="fac-search-clear" onClick={() => setCategorySearch('')} title={i18n.t('common:clear', { defaultValue: 'Clear' })}>
                      <CrossSvg size={12} />
                    </button>
                  )}
                </div>

                <div className="fac-category-preset-strip">
                  <div className="fac-preset-left">
                    <button
                      className={`fac-btn-mini ${isAllCategoriesMode ? 'active' : ''}`}
                      onClick={handleSelectAllCategories}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      <CheckSvg size={11} />
                      <span>{i18n.t('settings:failover.selectAll', { defaultValue: 'Select All' })}</span>
                    </button>
                    <button
                      className={`fac-btn-mini ${selectedCategoryIds.includes('__NONE__') ? 'active' : ''}`}
                      onClick={handleClearCategories}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      <CrossSvg size={11} />
                      <span>{i18n.t('settings:failover.clearAll', { defaultValue: 'Clear All' })}</span>
                    </button>
                  </div>

                  <div className="fac-expand-collapse-group">
                    <button className="fac-btn-mini-link" onClick={handleExpandAllSources}>
                      {i18n.t('settings:failover.expandAll', { defaultValue: 'Expand All' })}
                    </button>
                    <span style={{ opacity: 0.4 }}>•</span>
                    <button className="fac-btn-mini-link" onClick={handleCollapseAllSources}>
                      {i18n.t('settings:failover.collapseAll', { defaultValue: 'Collapse All' })}
                    </button>
                  </div>
                </div>
              </div>

              {/* Count Summary */}
              <div className="fac-category-count-bar">
                <span>
                  {isAllCategoriesMode
                    ? i18n.t('settings:failover.searchingAllCategories', { count: categories.length, defaultValue: 'Scanning all {{count}} categories' })
                    : i18n.t('settings:failover.categoriesSelected', { count: selectedCategoryIds.length, defaultValue: '{{count}} categories selected' })}
                </span>
                <span className="fac-showing-count">
                  {i18n.t('settings:failover.showingCount', {
                    defaultValue: '{{categories}} categories across {{sources}} sources',
                    categories: filteredCategories.length,
                    sources: categoriesBySource.length,
                  })}
                </span>
              </div>

              {/* Accordion List grouped by Source */}
              <div className="fac-categories-list">
                {categoriesBySource.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '30px 10px', color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem' }}>
                    {i18n.t('settings:failover.noCategoriesFound', { defaultValue: 'No categories matching filter' })}
                  </div>
                ) : (
                  categoriesBySource.map((group) => {
                    const isExpanded = expandedSourceIds.has(group.sourceId);
                    const groupCatIds = group.categories.map((c) => String(c.category_id));

                    let isAllGroupSelected = false;
                    let isSomeGroupSelected = false;
                    let selectedCount = 0;

                    if (isAllCategoriesMode) {
                      isAllGroupSelected = true;
                      selectedCount = group.categories.length;
                    } else {
                      const selectedInGroup = groupCatIds.filter((id) => selectedCategoryIds.includes(id));
                      selectedCount = selectedInGroup.length;
                      isAllGroupSelected = group.categories.length > 0 && selectedCount === group.categories.length;
                      isSomeGroupSelected = selectedCount > 0 && !isAllGroupSelected;
                    }

                    return (
                      <div
                        key={group.sourceId}
                        className={`fac-source-group-card ${isExpanded ? 'expanded' : ''}`}
                      >
                        <div
                          className="fac-source-group-header"
                          onClick={() => toggleSourceAccordion(group.sourceId)}
                        >
                          <div className="fac-source-group-left">
                            <svg
                              className={`fac-source-chevron ${isExpanded ? 'expanded' : ''}`}
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                            >
                              <polyline points="9 18 15 12 9 6" />
                            </svg>
                            <input
                              type="checkbox"
                              checked={isAllGroupSelected}
                              ref={(el) => {
                                if (el) el.indeterminate = isSomeGroupSelected;
                              }}
                              onChange={(e) => {
                                e.stopPropagation();
                                handleToggleSourceCategories(group.sourceId, groupCatIds);
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <span className="fac-source-group-title" title={group.sourceName}>
                              {group.sourceName}
                            </span>
                          </div>

                          <div className="fac-source-group-right">
                            <span className={`fac-source-cat-count ${selectedCount > 0 ? 'has-selected' : ''}`}>
                              {selectedCount} / {group.categories.length}
                            </span>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="fac-source-group-body">
                            <div className="fac-source-group-body-grid">
                              {group.categories.map((c) => {
                                const catIdStr = String(c.category_id);
                                const isChecked = isAllCategoriesMode || selectedCategoryIds.includes(catIdStr);
                                return (
                                  <label
                                    key={catIdStr}
                                    className={`fac-cat-checkbox-item ${isChecked ? 'is-selected' : ''}`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() => handleToggleCategory(catIdStr)}
                                    />
                                    <span title={c.category_name}>{c.category_name}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* TAB 4: Results & Suggestions Review */}
          {activeTab === 'results' && (
            <>
              {isScanning ? (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: 'rgba(255,255,255,0.7)' }}>
                  <div style={{ fontSize: '1.8rem', marginBottom: '16px', display: 'flex', justifyContent: 'center' }}>
                    <RefreshSvg size={36} />
                  </div>
                  <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>{i18n.t('settings:failover.scanningChannels', { defaultValue: 'Scanning channels and matching streams...' })}</div>
                </div>
              ) : saveError ? (
                <div className="fac-save-error">
                  <CrossSvg size={16} />
                  <span>{saveError}</span>
                  <button
                    className="fac-btn-mini"
                    onClick={() => setSaveError(null)}
                    title={i18n.t('common:close', { defaultValue: 'Close' })}
                  >
                    <CrossSvg size={12} />
                  </button>
                </div>
              ) : proposedGroups.length === 0 && existingAdditions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: 'rgba(255,255,255,0.5)' }}>
                  <div style={{ fontSize: '1.8rem', marginBottom: '14px', display: 'flex', justifyContent: 'center', opacity: 0.6 }}>
                    <TvSvg size={36} />
                  </div>
                  <div>{i18n.t('settings:failover.noGroupsFound', { defaultValue: 'No new multi-stream clusters found matching current filters.' })}</div>
                </div>
              ) : (
                <>
                  {proposedGroups.length > 0 && acceptedGroupKeys.size === proposedGroups.length ? (
                    <div className="fac-results-summary" style={{ background: 'rgba(76, 175, 80, 0.15)', borderColor: 'rgba(76, 175, 80, 0.4)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ color: '#81c784' }}><CheckSvg size={20} /></span>
                        <div>
                          <div style={{ fontWeight: 600, color: '#81c784' }}>
                            {i18n.t('settings:failover.allGroupsSaved', { defaultValue: 'All {{count}} Groups Successfully Saved!', count: proposedGroups.length })}
                          </div>
                          <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.7)', marginTop: '2px' }}>
                            {i18n.t('settings:failover.streamsAddedToDatabase', { defaultValue: '{{count}} streams have been added to your failover database.', count: proposedGroups.reduce((acc, g) => acc + g.channels.length, 0) })}
                          </div>
                        </div>
                      </div>
                      <button className="fac-btn-primary" onClick={onClose} style={{ background: '#4caf50', color: '#fff' }}>
                        {i18n.t('settings:failover.doneViewGroups', { defaultValue: 'Done & View Groups ➜' })}
                      </button>
                    </div>
                  ) : (
                    <div className="fac-results-summary">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <SparklesSvg size={16} />
                        <span>
                          {i18n.t('settings:failover.foundSummary', {
                            defaultValue: 'Found {{groups}} Proposed Groups ({{channels}} Streams) and {{additions}} Existing Group Additions',
                            groups: proposedGroups.length,
                            channels: proposedGroups.reduce((acc, g) => acc + g.channels.length, 0),
                            additions: existingAdditions.length,
                          })}
                        </span>
                      </div>
                      {proposedGroups.some((g) => !acceptedGroupKeys.has(g.key)) && (
                        <button
                          className="fac-btn-primary"
                          onClick={handleAcceptAll}
                          disabled={saving}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                        >
                          <CheckSvg size={14} />
                          <span>
                            {saving
                              ? i18n.t('settings:failover.savingGroups', { defaultValue: 'Saving {{count}} Groups...', count: proposedGroups.filter((g) => !acceptedGroupKeys.has(g.key)).length })
                              : i18n.t('settings:failover.acceptAll', { defaultValue: 'Accept All Groups' })}
                          </span>
                        </button>
                      )}
                    </div>
                  )}

                  {/* Additions to Existing Groups */}
                  {existingAdditions.length > 0 && (
                    <div className="fac-section">
                      <div className="fac-section-title">
                        <PlusSvg size={16} />
                        <span>{i18n.t('settings:failover.additionsTitle', { defaultValue: 'Additions to Existing Groups' })}</span>
                      </div>
                      <div className="fac-groups-list">
                        {existingAdditions.map((addition) => {
                          const isDone = acceptedAdditionGroupIds.has(addition.groupId);
                          return (
                            <div key={addition.groupId} className="fac-group-card">
                              <div className="fac-group-card-header">
                                <div className="fac-group-card-title-row">
                                  <span className="fac-group-card-name">{addition.groupName}</span>
                                  <span className="fac-tab-badge">{i18n.t('settings:failover.newStreams', { defaultValue: '{{count}} New Streams', count: addition.candidates.length })}</span>
                                </div>
                                <div className="fac-group-card-actions">
                                  {isDone ? (
                                    <span className="fac-confidence-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                      <CheckSvg size={12} />
                                      <span>{i18n.t('settings:failover.added', { defaultValue: 'Added' })}</span>
                                    </span>
                                  ) : (
                                    <button
                                      className="fac-card-accept-btn"
                                      onClick={() => handleAcceptAddition(addition)}
                                      disabled={saving}
                                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                                    >
                                      <PlusSvg size={12} />
                                      <span>{i18n.t('settings:failover.addBackupsToGroup', { defaultValue: 'Add Backups to Group' })}</span>
                                    </button>
                                  )}
                                </div>
                              </div>
                              <div className="fac-group-card-members">
                                {addition.candidates.map((cand, idx) => {
                                  const sourceName = sourceNameMap.get(String(cand.channel.source_id));
                                  return (
                                    <div key={cand.channel.stream_id} className="fac-member-row">
                                      <div className="fac-member-left">
                                        <span className="fac-member-priority">{i18n.t('settings:failover.backupPlus', { defaultValue: 'Backup +{{num}}', num: idx + 1 })}</span>
                                        {cand.channel.stream_icon ? (
                                          <img src={cand.channel.stream_icon} className="fac-member-logo" alt="" />
                                        ) : (
                                          <span className="fac-member-logo-placeholder">
                                            <TvSvg size={14} />
                                          </span>
                                        )}
                                        <span className="fac-member-name">{cand.channel.alias || cand.channel.name}</span>
                                      </div>
                                      <div className="fac-member-right">
                                        <span className={`fac-quality-tag q-${cand.parsed.quality}`}>{cand.parsed.quality.toUpperCase()}</span>
                                        {sourceName && <span className="fac-source-badge">{sourceName}</span>}
                                        <span className="fac-confidence-pill">{i18n.t('settings:failover.percentMatch', { defaultValue: '{{percent}}% Match', percent: Math.round(cand.score * 100) })}</span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Proposed New Failover Groups */}
                  {proposedGroups.length > 0 && (
                    <div className="fac-groups-list">
                      {proposedGroups.map((group) => {
                        const isAccepted = acceptedGroupKeys.has(group.key);
                        return (
                          <div key={group.key} className="fac-group-card">
                            <div className="fac-group-card-header">
                              <div className="fac-group-card-title-row">
                                <span className="fac-group-card-name">{group.name}</span>
                                <span className="fac-confidence-pill">
                                  {i18n.t('settings:failover.percentMatch', { defaultValue: '{{percent}}% Match', percent: Math.round(group.confidence * 100) })}
                                </span>
                                <span className="fac-reason-pill">{group.reason}</span>
                              </div>
                              <div className="fac-group-card-actions">
                                {isAccepted ? (
                                  <span className="fac-confidence-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                    <CheckSvg size={12} />
                                    <span>{i18n.t('settings:failover.created', { defaultValue: 'Created' })}</span>
                                  </span>
                                ) : (
                                  <>
                                    <button
                                      className="fac-card-accept-btn"
                                      onClick={() => handleAcceptGroup(group)}
                                      disabled={saving}
                                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                                    >
                                      <CheckSvg size={12} />
                                      <span>{i18n.t('settings:failover.acceptGroup', { defaultValue: 'Accept Group' })}</span>
                                    </button>
                                    <button
                                      className="fac-card-dismiss-btn"
                                      onClick={() => handleDismissGroup(group.key)}
                                      title={i18n.t('common:dismiss', { defaultValue: 'Dismiss' })}
                                    >
                                      <CrossSvg size={12} />
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="fac-group-card-members">
                              {group.channels.map((ch) => {
                                const isPrimary = ch.priority === 0;
                                const sourceName = sourceNameMap.get(String(ch.source_id));
                                return (
                                  <div key={ch.stream_id} className="fac-member-row">
                                    <div className="fac-member-left">
                                      <span className={`fac-member-priority ${isPrimary ? 'primary' : ''}`}>
                                        {isPrimary
                                          ? i18n.t('settings:failover.primaryLabel', { defaultValue: 'Primary' })
                                          : i18n.t('settings:failover.backupNum', { defaultValue: 'Backup {{num}}', num: ch.priority })}
                                      </span>
                                      {ch.stream_icon ? (
                                        <img src={ch.stream_icon} className="fac-member-logo" alt="" />
                                      ) : (
                                        <span className="fac-member-logo-placeholder">
                                          <TvSvg size={14} />
                                        </span>
                                      )}
                                      <span className="fac-member-name">{ch.alias || ch.name}</span>
                                    </div>
                                    <div className="fac-member-right">
                                      <span className={`fac-quality-tag q-${ch.parsed.quality}`}>
                                        {ch.parsed.quality.toUpperCase()}
                                      </span>
                                      {sourceName && <span className="fac-source-badge">{sourceName}</span>}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="fac-footer">
          <span className="fac-footer-hint">
            {activeTab !== 'results'
              ? i18n.t('settings:failover.configFooterHint', { defaultValue: 'Configure your matching rules and click Run Smart Scan.' })
              : i18n.t('settings:failover.resultsFooterHint', { defaultValue: 'Review proposed groups and accept them to save to your failover list.' })}
          </span>
          <div className="fac-footer-actions">
            {activeTab !== 'results' ? (
              <button
                className="fac-btn-primary"
                onClick={handleRunScan}
                disabled={isScanning}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <ZapSvg size={14} />
                <span>{isScanning ? i18n.t('settings:failover.scanning', { defaultValue: 'Scanning...' }) : i18n.t('settings:failover.runScan', { defaultValue: 'Run Smart Scan' })}</span>
              </button>
            ) : (
              <button
                className="fac-btn-secondary"
                onClick={() => setActiveTab('strategy')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <SettingsSvg size={14} />
                <span>{i18n.t('settings:failover.adjustRules', { defaultValue: 'Adjust Rules' })}</span>
              </button>
            )}
            <button className="fac-btn-secondary" onClick={onClose}>
              {i18n.t('common:done')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
