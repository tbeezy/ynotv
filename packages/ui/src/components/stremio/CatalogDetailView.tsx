import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { InstalledAddon, StremioManifestCatalog, StremioMetaPreview } from '../../types/stremio';
import { fetchCatalog } from '../../services/stremio-addon';
import { useStremioAddonStore } from '../../stores/stremioAddonStore';
import {
  useStremioCatalogScrollPositions,
  useSetStremioCatalogScrollPosition,
  useSetStremioSelectedAddonId,
  useSetStremioSelectedCatalogId,
  useSetStremioSelectedCatalogType,
  useSetStremioSelectedCloudCatalogKey,
} from '../../stores/uiStore';
import { TRAKT_CATALOG_DEFINITIONS } from '../../services/scrobbler';
import { useSettingsStore } from '../../stores/settingsStore';
import { useStremioHover } from '../../contexts/StremioHoverContext';
import './StremioHome.css';

const HIDDEN_CATALOG_IDS = new Set(['last-videos', 'calendar-videos']);

interface CatalogDetailViewProps {
  addon: InstalledAddon;
  catalog: StremioManifestCatalog;
  onItemClick: (item: StremioMetaPreview) => void;
}

export function CatalogDetailView({ addon, catalog, onItemClick }: CatalogDetailViewProps) {
  useTranslation();
  const catalogKey = `${addon.id}:${catalog.type}:${catalog.id}`;
  const scrollPositions = useStremioCatalogScrollPositions();
  const setScrollPosition = useSetStremioCatalogScrollPosition();
  const setSelectedAddonId = useSetStremioSelectedAddonId();
  const setSelectedCatalogId = useSetStremioSelectedCatalogId();
  const setSelectedCatalogType = useSetStremioSelectedCatalogType();
  const setSelectedCloudCatalogKey = useSetStremioSelectedCloudCatalogKey();

  const addons = useStremioAddonStore((s) => s.enabledAddons);

  const [items, setItems] = useState<StremioMetaPreview[]>([]);
  // Trakt access is reactive — store selectors re-render when tokens change.
  const traktEnabled = useSettingsStore((s) => !!s.traktEnabled && !!s.traktAccessToken);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedGenre, setSelectedGenre] = useState('');

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const latestRequestRef = useRef(0);
  const restoredScrollRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingMoreRef = useRef(loadingMore);
  const hasMoreRef = useRef(hasMore);
  const itemsRef = useRef<StremioMetaPreview[]>(items);
  const PAGE_SIZE = 50;

  useEffect(() => { loadingMoreRef.current = loadingMore; }, [loadingMore]);
  useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  // Compute navigation filters
  const types = useMemo(() => {
    const set = new Set<string>();
    for (const a of addons) {
      for (const c of a.manifest.catalogs || []) {
        if (!HIDDEN_CATALOG_IDS.has(c.id)) {
          set.add(c.type);
        }
      }
    }
    return Array.from(set);
  }, [addons]);

  const typeOptions = useMemo(() => {
    const list = types.map((t) => ({
      value: t,
      label: t === 'series' ? i18n.t('stremio:series') : t.charAt(0).toUpperCase() + t.slice(1) + 's',
    }));
    if (traktEnabled) {
      list.push({ value: 'trakt', label: 'Trakt' });
    }
    return list;
  }, [types, traktEnabled]);

  const availableCatalogs = useMemo(() => {
    const list: { addon: InstalledAddon; catalog: StremioManifestCatalog }[] = [];
    for (const a of addons) {
      for (const c of a.manifest.catalogs || []) {
        if (c.type === catalog.type && !HIDDEN_CATALOG_IDS.has(c.id)) {
          list.push({ addon: a, catalog: c });
        }
      }
    }
    return list;
  }, [addons, catalog.type]);

  const genreExtra = useMemo(() => {
    return catalog.extra?.find((e) => e.name === 'genre');
  }, [catalog]);

  const genreOptions = useMemo(() => {
    return genreExtra?.options || [];
  }, [genreExtra]);

  const handleTypeChange = (newType: string) => {
    if (newType === 'trakt') {
      const s = useSettingsStore.getState();
      let defaultKey = '';
      if (s.traktEnabled && s.traktAccessToken) {
        const enabledCatalogs: Record<string, boolean> = s.traktCatalogsEnabled || {};
        const firstDef = TRAKT_CATALOG_DEFINITIONS.find((def) => enabledCatalogs[def.type] === true);
        if (firstDef) {
          defaultKey = `trakt-${firstDef.type}`;
        } else {
          const enabledLists = s.traktEnabledLists || [];
          if (enabledLists.length > 0) {
            defaultKey = `trakt-list-${enabledLists[0].id}`;
          }
        }
      }

      if (defaultKey) {
        setSelectedAddonId(null);
        setSelectedCatalogId(null);
        setSelectedCatalogType(null);
        setSelectedCloudCatalogKey(defaultKey);
      }
      return;
    }

    const match = addons
      .flatMap((a) => (a.manifest.catalogs || []).map((c) => ({ addon: a, catalog: c })))
      .find((x) => x.catalog.type === newType);
    if (match) {
      setSelectedAddonId(match.addon.id);
      setSelectedCatalogId(match.catalog.id);
      setSelectedCatalogType(match.catalog.type);
      setSelectedCloudCatalogKey(null);
      setSelectedGenre('');
    }
  };

  const handleCatalogChange = (compositeKey: string) => {
    const [addonId, catalogId, catalogType] = compositeKey.split('|');
    setSelectedAddonId(addonId);
    setSelectedCatalogId(catalogId);
    setSelectedCatalogType(catalogType);
    setSelectedGenre('');
  };

  const loadPage = useCallback(async (skip: number, replace = false) => {
    if (!replace && (loadingMoreRef.current || !hasMoreRef.current)) return;
    const requestId = ++latestRequestRef.current;
    if (replace) {
      setLoadingInitial(true);
      setError(null);
      setHasMore(true);
    } else {
      setLoadingMore(true);
    }

    try {
      const extraParams: Record<string, string> = {
        skip: String(skip),
        limit: String(PAGE_SIZE),
      };
      if (selectedGenre) {
        extraParams.genre = selectedGenre;
      }

      const resp = await fetchCatalog(addon.baseUrl, catalog.type, catalog.id, extraParams);
      if (requestId !== latestRequestRef.current) return;
      const metas = resp?.metas || [];
      
      const prevItems = itemsRef.current;
      const combined = replace ? metas : [...prevItems, ...metas];
      const seen = new Set<string>();
      const filtered = combined.filter((m) => {
        const key = `${m.type}:${m.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const receivedAnyNew = filtered.length > prevItems.length;
      setItems(filtered);

      // If we are appending items but didn't actually add any new unique elements,
      // it means the source has no more unique elements (or is repeating them).
      if (!replace && !receivedAnyNew) {
        setHasMore(false);
      }

      // If the response returns exactly 0 metas, we have reached the end.
      if (metas.length === 0) {
        setHasMore(false);
      }
    } catch {
      if (requestId === latestRequestRef.current && replace) setError(i18n.t('stremio:failedLoadCatalog'));
    } finally {
      if (requestId === latestRequestRef.current) {
        if (replace) setLoadingInitial(false);
        else setLoadingMore(false);
      }
    }
  }, [addon.baseUrl, catalog.type, catalog.id, selectedGenre]);

  useEffect(() => {
    latestRequestRef.current += 1;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    setItems([]);
    setHasMore(true);
    setError(null);
    restoredScrollRef.current = false;
    debounceTimerRef.current = setTimeout(() => {
      void loadPage(0, true);
    }, 150);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [catalogKey, selectedGenre, loadPage]);

  // Observe sentinel intersection relative to the .stremio-main scrolling container
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || loadingInitial || loadingMore || !hasMore) return;
    const mainEl = sentinel.closest('.stremio-main');
    if (!mainEl) return;
    const observer = new IntersectionObserver((entries) => {
      const first = entries[0];
      if (first?.isIntersecting) {
        void loadPage(items.length, false);
      }
    }, { root: mainEl, rootMargin: '400px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [items.length, hasMore, loadingInitial, loadingMore, loadPage]);

  // Restore scroll position on the actual scroll container (.stremio-main)
  useEffect(() => {
    if (loadingInitial || restoredScrollRef.current) return;
    const el = document.querySelector('.stremio-main');
    if (!el) return;
    const saved = scrollPositions[catalogKey];
    if (typeof saved === 'number' && saved > 0) {
      el.scrollTop = saved;
    }
    restoredScrollRef.current = true;
  }, [catalogKey, loadingInitial, scrollPositions]);

  // Track scroll position on the actual scroll container (.stremio-main)
  useEffect(() => {
    const el = document.querySelector('.stremio-main');
    if (!el) return;
    const onScroll = () => {
      setScrollPosition(catalogKey, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (el) setScrollPosition(catalogKey, el.scrollTop);
    };
  }, [catalogKey, setScrollPosition]);

  const { onCardMouseEnter, onCardMouseLeave, onCardClick } = useStremioHover();

  return (
    <div className="stremio-catalog-detail-view" ref={containerRef}>
      <div style={{ padding: '24px' }}>
        <div className="stremio-discover-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <button
              className="stremio-row-see-all-btn"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', height: '36px' }}
              onClick={() => {
                setSelectedAddonId(null);
                setSelectedCatalogId(null);
                setSelectedCatalogType(null);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
              </svg>
              {i18n.t('stremio:back')}
            </button>
            <h3 className="stremio-row-title" style={{ fontSize: '1.2rem' }}>{i18n.t('stremio:discover')}</h3>
          </div>

          <div className="stremio-discover-filters">
            {/* Type selector */}
            <select
              className="stremio-discover-select"
              value={catalog.type}
              onChange={(e) => handleTypeChange(e.target.value)}
            >
              {typeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            {/* Catalog selector */}
            <select
              className="stremio-discover-select"
              value={`${addon.id}|${catalog.id}|${catalog.type}`}
              onChange={(e) => handleCatalogChange(e.target.value)}
            >
              {availableCatalogs.map(({ addon: a, catalog: c }) => (
                <option key={`${a.id}|${c.id}|${c.type}`} value={`${a.id}|${c.id}|${c.type}`}>
                  {c.name || `${a.manifest.name} - ${c.type}`}
                </option>
              ))}
            </select>

            {/* Genre selector (if options available) */}
            {genreOptions.length > 0 && (
              <select
                className="stremio-discover-select"
                value={selectedGenre}
                onChange={(e) => setSelectedGenre(e.target.value)}
              >
                <option value="">{i18n.t('stremio:allGenres')}</option>
                {genreOptions.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {loadingInitial ? (
          <div className="stremio-loading-text" style={{ padding: '80px 0' }}>{i18n.t('stremio:loadingCatalog')}</div>
        ) : error ? (
          <div className="stremio-loading-text" style={{ padding: '80px 0' }}>{error}</div>
        ) : items.length === 0 ? (
          <div className="stremio-loading-text" style={{ padding: '80px 0' }}>{i18n.t('stremio:noItemsInCatalog')}</div>
        ) : (
          <>
            <div className="stremio-meta-grid">
              {items.map((item) => (
                <div
                  key={`${item.type}:${item.id}`}
                  className="stremio-meta-card"
                  onMouseEnter={(e) => onCardMouseEnter(item, e.currentTarget, e)}
                  onMouseLeave={onCardMouseLeave}
                  onClick={() => {
                    onCardClick();
                    onItemClick(item);
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
            {hasMore && (
              <div ref={sentinelRef} className="stremio-loading-text" style={{ padding: '20px 0', textAlign: 'center' }}>
                {loadingMore ? i18n.t('stremio:loadingMore') : ''}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
