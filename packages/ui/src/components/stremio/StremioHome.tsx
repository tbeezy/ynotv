import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { InstalledAddon, StremioMetaPreview, StremioMeta } from '../../types/stremio';
import { fetchCatalog, fetchMeta } from '../../services/stremio-addon';
import { scrobbler, TRAKT_CATALOG_DEFINITIONS, type TraktCatalogType } from '../../services/scrobbler';
import {
  useStremioSearchQuery,
  useStremioView,
  useSetStremioView,
  useStremioSelectedAddonId,
  useSetStremioSelectedAddonId,
  useStremioSelectedCatalogId,
  useSetStremioSelectedCatalogId,
  useStremioSelectedCatalogType,
  useSetStremioSelectedCatalogType,
  useTraktCatalogRefreshToken,
  useSetStremioSelectedSeason,
  useSetStremioPreselectVideoId,
  useStremioSelectedCloudCatalogKey,
  useSetStremioSelectedCloudCatalogKey,
  useUIStore,
} from '../../stores/uiStore';
import { useTmdbApiKey } from '../../hooks/useTmdbLists';
import { useSettingsStore } from '../../stores/settingsStore';
import { SERVICES, type StreamingService } from '../../constants/streamingProviders';
import { StreamingServiceView } from './StreamingServiceView';
import { StremioCatalogRow } from './StremioCatalogRow';
import { CatalogDetailView } from './CatalogDetailView';
import { CloudCatalogDetailView } from './CloudCatalogDetailView';
import { StremioRecentlyWatched } from './StremioRecentlyWatched';
import { StremioHeroBanner } from './StremioHeroBanner';
import { useStremioHover } from '../../contexts/StremioHoverContext';
import './StremioHome.css';

interface StremioHomeProps {
  addons: InstalledAddon[];
  onItemClick: (meta: StremioMeta) => void;
}

type StremioSearchResult = StremioMetaPreview & {
  sourceAddonId: string;
};

type StremioSearchRow = {
  id: string;
  title: string;
  items: StremioSearchResult[];
};

const HIDDEN_CATALOG_IDS = new Set(['last-videos', 'calendar-videos']);

function addonHasResource(addon: InstalledAddon, resource: string): boolean {
  return addon.manifest.resources.some((r) => {
    if (typeof r === 'string') return r === resource;
    return r.name === resource;
  });
}

export function StremioHome({ addons, onItemClick }: StremioHomeProps) {
  useTranslation();
  const searchQuery = useStremioSearchQuery();
  const view = useStremioView();
  const setView = useSetStremioView();
  const selectedAddonId = useStremioSelectedAddonId();
  const setSelectedAddonId = useSetStremioSelectedAddonId();
  const selectedCatalogId = useStremioSelectedCatalogId();
  const setSelectedCatalogId = useSetStremioSelectedCatalogId();
  const selectedCatalogType = useStremioSelectedCatalogType();
  const setSelectedCatalogType = useSetStremioSelectedCatalogType();
  const [searchRows, setSearchRows] = useState<StremioSearchRow[]>([]);
  const [expandedSearchRowId, setExpandedSearchRowId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchingAddons, setSearchingAddons] = useState<string[]>([]);
  const searchSessionRef = useRef(0);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const tmdbApiKey = useTmdbApiKey();
  const streamingCatalogsEnabled = useSettingsStore((s) => s.streamingCatalogsEnabled);
  const enabledStreamingServices = useSettingsStore((s) => s.enabledStreamingServices);
  const [showScrollTop, setShowScrollTop] = useState(false);

  const scrollToTop = useCallback(() => {
    const el = document.querySelector('.stremio-main');
    if (el) {
      el.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  // Streaming-catalog settings come from the settings store (setters keep them
  // current — no IPC read or event listener needed).

  const serviceScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollServiceLeft, setCanScrollServiceLeft] = useState(false);
  const [canScrollServiceRight, setCanScrollServiceRight] = useState(false);

  const updateServiceScrollButtons = useCallback(() => {
    const el = serviceScrollRef.current;
    if (!el) return;
    setCanScrollServiceLeft(el.scrollLeft > 2);
    setCanScrollServiceRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  const handleServiceRailScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    updateServiceScrollButtons();
    const el = e.currentTarget;
    if (el.clientWidth > 0) {
      useUIStore.getState().setStremioCatalogScrollPosition('service-rail', el.scrollLeft);
    }
  }, [updateServiceScrollButtons]);

  useEffect(() => {
    if (!tmdbApiKey) return;
    updateServiceScrollButtons();
    window.addEventListener('resize', updateServiceScrollButtons);
    
    // Add small delay to let children render and compute scroll width
    const timer = setTimeout(updateServiceScrollButtons, 150);

    return () => {
      window.removeEventListener('resize', updateServiceScrollButtons);
      clearTimeout(timer);
    };
  }, [tmdbApiKey, updateServiceScrollButtons]);

  const scrollService = (dir: 'left' | 'right') => {
    const el = serviceScrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.75;
    el.scrollTo({ left: el.scrollLeft + (dir === 'left' ? -amount : amount), behavior: 'smooth' });
  };

  const refreshToken = useTraktCatalogRefreshToken();
  const setSelectedSeason = useSetStremioSelectedSeason();
  const setPreselectVideoId = useSetStremioPreselectVideoId();
  const selectedCloudCatalogKey = useStremioSelectedCloudCatalogKey();
  const setSelectedCloudCatalogKey = useSetStremioSelectedCloudCatalogKey();

  interface CloudCatalogRow {
    key: string;
    title: string;
    items: StremioMetaPreview[];
    page: number;
    hasMore: boolean;
  }
  const [cloudCatalogRows, setCloudCatalogRows] = useState<CloudCatalogRow[]>([]);
  const [traktCatalogsBeforeAddon, setTraktCatalogsBeforeAddon] = useState(false);

  // Fetch cloud catalogs on mount or when view changes back to home/search
  useEffect(() => {
    let active = true;
    const loadScrobblerCatalogs = async () => {
      if (!window.storage) return;
      try {
        const res = await window.storage.getSettings();
        const s = res.data || {};
        
        if (!active) return;
        
        // Load Trakt catalogs dynamically based on enabled settings
        const rows: CloudCatalogRow[] = [];
        if (s.traktEnabled && s.traktAccessToken) {
          const enabledCatalogs: Record<string, boolean> = s.traktCatalogsEnabled || {};
          const enabledDefs = TRAKT_CATALOG_DEFINITIONS.filter(
            (def) => enabledCatalogs[def.type] === true
          );

          const results = await Promise.all(
            enabledDefs.map((def) =>
              scrobbler.fetchTraktCatalog(def.type, 1).then(({ items, hasMore }) => ({
                key: `trakt-${def.type}`,
                title: `Trakt ${def.label}`,
                items,
                page: 1,
                hasMore,
              }))
            )
          );
          rows.push(...results.filter((r) => r.items.length > 0));

          // Load Trakt custom lists
          const enabledLists: { id: string; name: string }[] = s.traktEnabledLists || [];
          const listResults = await Promise.all(
            enabledLists.map((list) =>
              scrobbler.fetchTraktListCatalog(list.id, 1).then(({ items, hasMore }) => ({
                key: `trakt-list-${list.id}`,
                title: `Trakt \u2014 ${list.name}`,
                items,
                page: 1,
                hasMore,
              }))
            )
          );
          rows.push(...listResults.filter((r) => r.items.length > 0));

          // Apply catalog order from settings
          const order = s.traktCatalogOrder || [];
          if (order.length > 0) {
            rows.sort((a, b) => {
              const keyA = a.key.replace('trakt-', '');
              const keyB = b.key.replace('trakt-', '');
              const iA = order.indexOf(keyA);
              const iB = order.indexOf(keyB);
              return (iA === -1 ? 999 : iA) - (iB === -1 ? 999 : iB);
            });
          }
        }
        if (active) {
          setCloudCatalogRows(rows);
          setTraktCatalogsBeforeAddon(s.traktCatalogsBeforeAddon ?? false);
        }
      } catch (e) {
        console.error('Failed to load scrobbler catalogs in StremioHome:', e);
      }
    };

    loadScrobblerCatalogs();
    return () => {
      active = false;
    };
  }, [view, refreshToken]);

  const handleTraktPageChange = useCallback(async (row: CloudCatalogRow, newPage: number) => {
    if (newPage < 1) return;
    try {
      const isList = row.key.startsWith('trakt-list-');
      let result: { items: StremioMetaPreview[]; hasMore: boolean };
      if (isList) {
        const listId = row.key.slice('trakt-list-'.length);
        result = await scrobbler.fetchTraktListCatalog(listId, newPage);
      } else {
        const type = row.key.replace('trakt-', '') as TraktCatalogType;
        result = await scrobbler.fetchTraktCatalog(type, newPage);
      }
      setCloudCatalogRows((prev) =>
        prev.map((r) =>
          r.key === row.key
            ? { ...r, items: result.items, page: newPage, hasMore: result.hasMore }
            : r
        )
      );
    } catch (e) {
      console.error(`Failed to load Trakt page ${newPage} for ${row.key}:`, e);
    }
  }, []);

  const { onCardMouseEnter, onCardMouseLeave, onCardClick } = useStremioHover();

  const renderedRows = useMemo(() => {
    return addons.flatMap((addon) =>
      (addon.manifest.catalogs || [])
        .filter((cat) => !HIDDEN_CATALOG_IDS.has(cat.id))
        .map((cat) => ({
          addon,
          catalog: cat,
        }))
    );
  }, [addons]);

  const filteredRows = useMemo(() => {
    if (!catalogFilter.trim()) return renderedRows;
    const lower = catalogFilter.toLowerCase().trim();
    return renderedRows.filter(({ addon, catalog }) => {
      const name = catalog.name || addon.manifest.name || '';
      return name.toLowerCase().includes(lower);
    });
  }, [renderedRows, catalogFilter]);

  const filteredCloudRows = useMemo(() => {
    if (!catalogFilter.trim()) return cloudCatalogRows;
    const lower = catalogFilter.toLowerCase().trim();
    return cloudCatalogRows.filter((row) => {
      const name = row.title || '';
      return name.toLowerCase().includes(lower);
    });
  }, [cloudCatalogRows, catalogFilter]);

  const doSearch = useCallback(async (query: string) => {
    if (!query || query.length < 2) {
      setSearchRows([]);
      setExpandedSearchRowId(null);
      setSearching(false);
      setSearchingAddons([]);
      return;
    }

    // Increment session ID for this new search
    searchSessionRef.current += 1;
    const currentSession = searchSessionRef.current;

    setSearchRows([]);
    setSearching(true);

    // Identify all search targets (addon + catalog combination)
    const targets: {
      addonId: string;
      addonName: string;
      catType: string;
      catId: string;
      catName: string;
      baseUrl: string;
    }[] = [];

    for (const addon of addons) {
      if (!addonHasResource(addon, 'catalog') || !addonHasResource(addon, 'meta')) continue;
      for (const cat of addon.manifest.catalogs || []) {
        if (cat.extra?.some(e => e.name === 'search') || cat.extraSupported?.includes('search')) {
          targets.push({
            addonId: addon.id,
            addonName: addon.manifest.name || 'Addon',
            catType: cat.type,
            catId: cat.id,
            catName: cat.name || addon.manifest.name || 'Addon',
            baseUrl: addon.baseUrl,
          });
        }
      }
    }

    if (targets.length === 0) {
      setSearching(false);
      setSearchingAddons([]);
      return;
    }

    // Set initial list of active search targets
    const initialAddonsList = targets.map(t => `${t.addonName} (${t.catType})`);
    setSearchingAddons(initialAddonsList);

    // Run searches in parallel
    targets.forEach(async (target) => {
      const targetLabel = `${target.addonName} (${target.catType})`;
      try {
        const resp = await fetchCatalog(target.baseUrl, target.catType, target.catId, { search: query });
        
        // Verify this query is still current
        if (searchSessionRef.current !== currentSession) return;

        if (resp?.metas && resp.metas.length > 0) {
          const rowItems: StremioSearchResult[] = [];
          const seenInRow = new Set<string>();
          for (const m of resp.metas) {
            const key = `${m.type}:${m.id}`;
            if (!seenInRow.has(key)) {
              seenInRow.add(key);
              rowItems.push({ ...m, sourceAddonId: target.addonId });
            }
          }

          if (rowItems.length > 0) {
            const newRow: StremioSearchRow = {
              id: `${target.addonId}:${target.catType}:${target.catId}`,
              title: `${target.catName} \u2014 ${target.catType.charAt(0).toUpperCase() + target.catType.slice(1)}`,
              items: rowItems,
            };
            setSearchRows((prev) => {
              // Ensure we don't add duplicate rows
              if (prev.some(r => r.id === newRow.id)) return prev;
              return [...prev, newRow];
            });
          }
        }
      } catch (err) {
        console.warn(`Search failed for ${targetLabel}:`, err);
      } finally {
        if (searchSessionRef.current === currentSession) {
          setSearchingAddons((prev) => {
            const updated = prev.filter(label => label !== targetLabel);
            if (updated.length === 0) {
              setSearching(false);
            }
            return updated;
          });
        }
      }
    });
  }, [addons]);

  useEffect(() => {
    if (view === 'search' && searchQuery.length >= 2) {
      doSearch(searchQuery);
    }
  }, [searchQuery, view, doSearch]);

  const handleItemClickWrapper = useCallback(async (preview: StremioMetaPreview | StremioSearchResult) => {
    const p = preview as any;
    // Deep-link to specific season/episode for Trakt history items
    if (p.traktSeason != null && p.traktEpisode != null) {
      setSelectedSeason(p.traktSeason);
      setPreselectVideoId(`${p.id}:${p.traktSeason}:${p.traktEpisode}`);
    }

    if (preview.id.startsWith('tmdb:')) {
      const newMeta: StremioMeta = {
        id: preview.id,
        type: preview.type,
        name: preview.name,
        poster: preview.poster ?? undefined,
        imdbRating: preview.imdbRating,
      };
      onItemClick(newMeta);
      return;
    }

    // Query across all addons to fetch full metadata
    const meta = await fetchMeta(addons, preview.type, preview.id);
    if (meta) {
      onItemClick(meta);
    }
  }, [addons, onItemClick, setSelectedSeason, setPreselectVideoId]);

  const selectedCatalogItems = useMemo(() => {
    if (selectedAddonId && selectedCatalogId && selectedCatalogType) {
      const addon = addons.find(a => a.id === selectedAddonId);
      if (addon) {
        const cat = addon.manifest.catalogs?.find(
          c => c.id === selectedCatalogId && c.type === selectedCatalogType
        );
        if (cat) return { addon, catalog: cat };
      }
    }
    return null;
  }, [addons, selectedAddonId, selectedCatalogId, selectedCatalogType]);

  // Save/restore main scrollbar vertical position for the Stremio Home page
  useEffect(() => {
    const isHomeActive = !selectedService && !selectedCatalogItems && !selectedCloudCatalogKey && view === 'home';
    if (!isHomeActive) return;

    const el = document.querySelector('.stremio-main');
    if (!el) return;

    const saved = useUIStore.getState().stremioCatalogScrollPositions['home-vertical'];
    if (typeof saved === 'number' && saved > 0) {
      const timer = setTimeout(() => {
        el.scrollTop = saved;
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [selectedService, selectedCatalogItems, selectedCloudCatalogKey, view]);

  useEffect(() => {
    const isHomeActive = !selectedService && !selectedCatalogItems && !selectedCloudCatalogKey && view === 'home';
    if (!isHomeActive) {
      setShowScrollTop(false);
      return;
    }

    const el = document.querySelector('.stremio-main');
    if (!el) return;

    // Set initial state based on current scroll position
    setShowScrollTop(el.scrollTop > 400);

    const handleScroll = () => {
      if (el.clientHeight > 0) {
        const scrollTop = el.scrollTop;
        useUIStore.getState().setStremioCatalogScrollPosition('home-vertical', scrollTop);
        setShowScrollTop(scrollTop > 400);
      }
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [selectedService, selectedCatalogItems, selectedCloudCatalogKey, view]);

  useEffect(() => {
    const isHomeActive = !selectedService && !selectedCatalogItems && !selectedCloudCatalogKey && view === 'home';
    if (!isHomeActive) return;

    const el = serviceScrollRef.current;
    if (!el) return;

    const saved = useUIStore.getState().stremioCatalogScrollPositions['service-rail'];
    if (typeof saved === 'number' && saved > 0) {
      const timer = setTimeout(() => {
        el.scrollLeft = saved;
        updateServiceScrollButtons();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [selectedService, selectedCatalogItems, selectedCloudCatalogKey, view, tmdbApiKey, streamingCatalogsEnabled, enabledStreamingServices, updateServiceScrollButtons]);

  if (view === 'search') {
    const showLoadingIndicator = searchingAddons.length > 0;
    const hasResults = searchRows.length > 0;

    return (
      <div className="stremio-home">
        <div className="stremio-search-results">
          {hasResults && (
            <div className="stremio-catalog-rows">
              {searchRows.map((row) => (
                <div key={row.id}>
                  <StremioCatalogRow
                    title={row.title}
                    items={row.items.slice(0, 20)}
                    onItemClick={handleItemClickWrapper}
                    onSeeAll={() => setExpandedSearchRowId((prev) => (prev === row.id ? null : row.id))}
                    seeAllLabel={expandedSearchRowId === row.id ? i18n.t('stremio:collapse') : i18n.t('stremio:seeAllCount', { count: row.items.length })}
                  />
                  {expandedSearchRowId === row.id && (
                    <div className="stremio-search-expanded">
                      <div className="stremio-search-expanded-grid">
                        {row.items.map((item) => (
                          <div
                            key={`${row.id}:${item.type}:${item.id}`}
                            className="stremio-meta-card"
                            onMouseEnter={(e) => onCardMouseEnter(item, e.currentTarget, e)}
                            onMouseLeave={onCardMouseLeave}
                            onClick={() => {
                              onCardClick();
                              handleItemClickWrapper(item);
                            }}
                          >
                            {item.poster && (
                              <img
                                className="stremio-meta-poster"
                                src={item.poster}
                                alt={item.name}
                                loading="lazy"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                              />
                            )}
                            <div className="stremio-meta-card-info">
                              <div className="stremio-meta-card-title">{item.name}</div>
                              {item.imdbRating && <div className="stremio-meta-card-rating">★ {item.imdbRating}</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {showLoadingIndicator && (
            <div className="stremio-loading-text stremio-search-progress-indicator" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: hasResults ? '20px 0' : '40px 0', justifyContent: 'center', color: 'rgba(255, 255, 255, 0.45)', fontSize: '0.9rem' }}>
              <div className="stremio-spinner" style={{ width: '14px', height: '14px', borderWidth: '1.5px' }} />
              <span>{i18n.t('stremio:searchingIn', { addons: searchingAddons.join(', ') })}</span>
            </div>
          )}

          {!hasResults && !showLoadingIndicator && searchQuery.length >= 2 && (
            <div className="stremio-loading-text">{i18n.t('stremio:noResultsFound')}</div>
          )}

          {!hasResults && !showLoadingIndicator && searchQuery.length < 2 && (
            <div className="stremio-loading-text">{i18n.t('stremio:typeAtLeast2Chars')}</div>
          )}
        </div>
      </div>
    );
  }

  if (selectedService) {
    return (
      <div className="stremio-home">
        <StreamingServiceView
          service={selectedService}
          onBack={() => setSelectedService(null)}
          onItemClick={handleItemClickWrapper}
          addons={addons}
        />
      </div>
    );
  }

  if (selectedCatalogItems) {
    const { addon: selAddon, catalog: selCat } = selectedCatalogItems;
    return (
      <div className="stremio-home">
        <CatalogDetailView
          key={`${selAddon.id}:${selCat.id}`}
          addon={selAddon}
          catalog={selCat}
          onItemClick={handleItemClickWrapper}
        />
      </div>
    );
  }

  if (selectedCloudCatalogKey) {
    return (
      <div className="stremio-home">
        <CloudCatalogDetailView
          key={selectedCloudCatalogKey}
          cloudCatalogKey={selectedCloudCatalogKey}
          onItemClick={handleItemClickWrapper}
          onBack={() => setSelectedCloudCatalogKey(null)}
        />
      </div>
    );
  }

  return (
    <div className="stremio-home">
      <div className="stremio-catalog-filter">
        <svg className="stremio-catalog-filter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          className="stremio-catalog-filter-input"
          type="text"
          placeholder={i18n.t('stremio:filterCatalogs')}
          value={catalogFilter}
          onChange={(e) => setCatalogFilter(e.target.value)}
        />
        {catalogFilter && (
          <button className="stremio-catalog-filter-clear" onClick={() => setCatalogFilter('')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <StremioHeroBanner
        addons={addons}
        onItemClick={handleItemClickWrapper}
      />
      <div className="stremio-catalog-rows">
        <StremioRecentlyWatched
          addons={addons}
          onItemClick={onItemClick}
        />

        {tmdbApiKey && streamingCatalogsEnabled && (
          <div className="stremio-row stremio-rw-row" style={{ position: 'relative' }}>
            <div className="stremio-row-header">
              <h3 className="stremio-row-title stremio-rw-title">
                {i18n.t('stremio:streamingPlatforms')}
              </h3>
              <div className="stremio-row-nav">
                <button
                  className="stremio-row-nav-btn"
                  onClick={() => scrollService('left')}
                  disabled={!canScrollServiceLeft}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
                <button
                  className="stremio-row-nav-btn"
                  onClick={() => scrollService('right')}
                  disabled={!canScrollServiceRight}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="stremio-service-rail-scroll-wrapper" style={{ position: 'relative' }}>
              <div
                className="stremio-service-rail-scroll"
                ref={serviceScrollRef}
                onScroll={handleServiceRailScroll}
              >
                <div className="stremio-service-rail-track">
                  {Object.keys(SERVICES)
                    .filter((svcKey) => enabledStreamingServices.includes(svcKey))
                    .map((svcKey) => {
                      const svc = SERVICES[svcKey as StreamingService];
                      return (
                        <button
                          key={svcKey}
                          className="stremio-service-tile-btn"
                          onClick={() => setSelectedService(svcKey)}
                        >
                          <img
                            src={svc.logo}
                            alt={svc.name}
                            style={{
                              height: svc.logoHeightHome ? `${svc.logoHeightHome}px` : '24px',
                              width: 'auto',
                              filter: svc.logoFilter || 'none',
                            }}
                          />
                        </button>
                      );
                    })}
                </div>
              </div>
              {canScrollServiceLeft && <div className="stremio-row-fade stremio-row-fade-left" style={{ zIndex: 3 }} />}
              {canScrollServiceRight && <div className="stremio-row-fade stremio-row-fade-right" style={{ zIndex: 3 }} />}
            </div>
          </div>
        )}

        {traktCatalogsBeforeAddon && filteredCloudRows.map((row) => (
          <StremioCatalogRow
            key={row.key}
            title={row.title}
            items={row.items}
            onItemClick={handleItemClickWrapper}
            onSeeAll={() => {
              setSelectedAddonId(null);
              setSelectedCatalogId(null);
              setSelectedCatalogType(null);
              setSelectedCloudCatalogKey(row.key);
            }}
          />
        ))}

        {filteredRows.length > 0 && (
          filteredRows.map(({ addon, catalog }) => (
            <StremioCatalogRow
              key={`${addon.id}:${catalog.type}:${catalog.id}`}
              title={`${catalog.name || addon.manifest.name} \u2014 ${catalog.type.charAt(0).toUpperCase() + catalog.type.slice(1)}`}
              addon={addon}
              catalog={catalog}
              onItemClick={handleItemClickWrapper}
              onSeeAll={() => {
                setSelectedAddonId(addon.id);
                setSelectedCatalogId(catalog.id);
                setSelectedCatalogType(catalog.type);
                setView('home');
              }}
            />
          ))
        )}

        {filteredRows.length === 0 && filteredCloudRows.length === 0 && (
          <div className="stremio-loading-text">
            {catalogFilter.trim() ? i18n.t('stremio:noCatalogsMatch') : i18n.t('stremio:noCatalogsAvailable')}
          </div>
        )}

        {!traktCatalogsBeforeAddon && filteredCloudRows.map((row) => (
          <StremioCatalogRow
            key={row.key}
            title={row.title}
            items={row.items}
            onItemClick={handleItemClickWrapper}
            onSeeAll={() => {
              setSelectedAddonId(null);
              setSelectedCatalogId(null);
              setSelectedCatalogType(null);
              setSelectedCloudCatalogKey(row.key);
            }}
          />
        ))}
      </div>

      <button
        className={`stremio-scroll-top ${showScrollTop ? 'visible' : ''}`}
        onClick={scrollToTop}
        aria-label={i18n.t('stremio:scrollToTop')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 15l-6-6-6 6" />
        </svg>
      </button>
    </div>
  );
}
