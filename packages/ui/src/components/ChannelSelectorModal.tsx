import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db, type StoredChannel, type StoredCategory } from '../db';
import './CustomGroupManager.css'; // Reuse the same styles

interface ChannelSelectorModalProps {
  currentChannelName: string | null;
  networkName: string | null; // For auto-populating search
  onSelect: (channel: StoredChannel | null) => void;
  onClose: () => void;
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

// Clean network name by removing country like "(United States)"
function cleanNetworkName(name: string | null): string {
  if (!name) return '';
  return name.replace(/\s*\([^)]+\)\s*$/, '').trim();
}

// ── SearchResults ─────────────────────────────────────────────────────────────

interface SearchResultsProps {
  query: string;
  selectedChannelId: string | null;
  onSelect: (ch: StoredChannel) => void;
  enabledSourceIdsKey: string;
  enabledSourceIds: Set<string> | undefined;
}

function SearchResults({ query, selectedChannelId, onSelect, enabledSourceIdsKey, enabledSourceIds }: SearchResultsProps) {
  const [results, setResults] = useState<StoredChannel[] | undefined>();

  useEffect(() => {
    let isMounted = true;
    if (!query || query.length < 2) { setResults([]); return; }

    async function search() {
      try {
        // Get enabled category IDs for category filtering
        let enabledCategoryIds: Set<string> | null = null;
        if (enabledSourceIds && enabledSourceIds.size > 0) {
          const sourceIdsList = Array.from(enabledSourceIds);
          const allCategories = await db.categories.toArray();
          enabledCategoryIds = new Set(
            allCategories
              .filter(c => enabledSourceIds.has(String(c.source_id)) && c.enabled !== false)
              .map(c => c.category_id)
          );
        }

        const all = await db.channels.whereRaw('name LIKE ?', [`%${query}%`]).limit(200).toArray();
        const filtered = all.filter(c => {
          if (c.enabled === false) return false;
          if (enabledSourceIds && !enabledSourceIds.has(String(c.source_id))) return false;
          // Filter out channels that don't belong to any enabled category
          if (enabledCategoryIds && enabledCategoryIds.size > 0) {
            const catIds = parseCategoryIds(c.category_ids);
            const hasEnabledCategory = catIds.some(id => enabledCategoryIds!.has(id));
            if (!hasEnabledCategory) return false;
          }
          return true;
        }).slice(0, 100);
        if (isMounted) setResults(filtered);
      } catch {
        if (isMounted) setResults([]);
      }
    }

    search();
    return () => { isMounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, enabledSourceIdsKey]);

  if (!results) return <div className="cgm-empty">Searching…</div>;
  if (results.length === 0) return <div className="cgm-empty">No results for "{query}"</div>;

  return (
    <div className="tree-root">
      {results.map(ch => {
        const isSelected = selectedChannelId === ch.stream_id;
        return (
          <div key={ch.stream_id} className={`channel-node${isSelected ? ' in-group' : ''}`}
            onClick={() => onSelect(ch)}>
            <span className="cgm-check">{isSelected ? '✓' : '+'}</span>
            {ch.stream_icon && <img src={ch.stream_icon} className="channel-node-logo" alt="" />}
            <span className="channel-node-label">{ch.name}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── TreeView ──────────────────────────────────────────────────────────────────

interface TreeViewProps {
  sourcesAndCategories: { sources: any[]; categories: StoredCategory[]; enabledSourceIds: Set<string> } | undefined;
  searchQuery: string;
  expandedNodes: Record<string, boolean>;
  toggleNode: (id: string) => void;
  selectedChannelId: string | null;
  onSelect: (ch: StoredChannel) => void;
  enabledSourceIdsKey: string;
  enabledSourceIds: Set<string> | undefined;
}

function TreeView({ sourcesAndCategories, searchQuery, expandedNodes, toggleNode, selectedChannelId, onSelect, enabledSourceIdsKey, enabledSourceIds }: TreeViewProps) {
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

  if (!sourcesAndCategories) return <div className="cgm-empty">Loading sources…</div>;

  if (searchQuery.length > 0) {
    return <SearchResults query={searchQuery} selectedChannelId={selectedChannelId} onSelect={onSelect} enabledSourceIdsKey={enabledSourceIdsKey} enabledSourceIds={enabledSourceIds} />;
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
                          {loadingNode === cat.category_id && catChannels.length === 0 && <div className="cgm-empty">Loading…</div>}
                          {loadingNode !== cat.category_id && catChannels.length === 0 && <div className="cgm-empty">No channels</div>}
                          {catChannels.map(ch => {
                            const isSelected = selectedChannelId === ch.stream_id;
                            return (
                              <div key={ch.stream_id} className={`channel-node${isSelected ? ' in-group' : ''}`}
                                onClick={() => onSelect(ch)}>
                                <span className="cgm-check">{isSelected ? '✓' : '+'}</span>
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

// ── Main ChannelSelectorModal ───────────────────────────────────────────────────

export function ChannelSelectorModal({ currentChannelName, networkName, onSelect, onClose }: ChannelSelectorModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [selectedChannel, setSelectedChannel] = useState<StoredChannel | null>(null);
  const [sourcesAndCategories, setSourcesAndCategories] = useState<{ sources: any[]; categories: StoredCategory[]; enabledSourceIds: Set<string> } | undefined>();
  const [loading, setLoading] = useState(true);

  const enabledSourceIdsKey = sourcesAndCategories
    ? Array.from(sourcesAndCategories.enabledSourceIds).sort().join(',')
    : '';

  // Initialize search with cleaned network name
  useEffect(() => {
    const cleaned = cleanNetworkName(networkName);
    if (cleaned) {
      setSearchQuery(cleaned);
    }
  }, [networkName]);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    async function loadData() {
      try {
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
        console.error('Failed to load channel selector data:', err);
        if (isMounted) setLoading(false);
      }
    }
    loadData();
    return () => { isMounted = false; };
  }, []);

  const handleSelect = (ch: StoredChannel) => {
    setSelectedChannel(ch);
  };

  const handleConfirm = () => {
    onSelect(selectedChannel);
    onClose();
  };

  const handleClear = () => {
    onSelect(null);
    onClose();
  };

  const toggleNode = (nodeId: string) => setExpandedNodes(prev => ({ ...prev, [nodeId]: !prev[nodeId] }));

  return (
    <div className="custom-group-manager-overlay" onClick={onClose}>
      <div className="custom-group-manager-modal" onClick={e => e.stopPropagation()}>

        <div className="custom-group-manager-header">
          <h2>Set Channel</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        {/* Current Channel Info */}
        {currentChannelName && (
          <div style={{ padding: '12px 20px', background: 'rgba(102, 126, 234, 0.1)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '13px' }}>Current: </span>
            <span style={{ color: '#a5b4fc', fontWeight: 600 }}>{currentChannelName}</span>
          </div>
        )}

        {/* Selected Channel Info */}
        {selectedChannel && (
          <div style={{ padding: '12px 20px', background: 'rgba(34, 197, 94, 0.1)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '13px' }}>New Selection: </span>
            <span style={{ color: '#4ade80', fontWeight: 600 }}>{selectedChannel.name}</span>
          </div>
        )}

        <div className="custom-group-content" style={{ height: '400px' }}>

          {/* Channel Selector Pane */}
          <div className="source-selector-pane" style={{ flex: 1 }}>
            <div className="search-bar">
              <input
                type="text"
                placeholder="Search channels…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                autoComplete="off"
                autoFocus
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
                  selectedChannelId={selectedChannel?.stream_id || null}
                  onSelect={handleSelect}
                  enabledSourceIdsKey={enabledSourceIdsKey}
                  enabledSourceIds={sourcesAndCategories?.enabledSourceIds}
                />
              }
            </div>
          </div>

        </div>

        <div className="custom-group-manager-footer">
          <span className="cgm-footer-hint">Click + to select a channel</span>
          <div style={{ display: 'flex', gap: '12px' }}>
            {currentChannelName && (
              <button className="close-done-btn" style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#f87171' }} onClick={handleClear}>
                Clear Channel
              </button>
            )}
            <button className="close-done-btn" onClick={handleConfirm} disabled={!selectedChannel}>
              Set Channel
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
