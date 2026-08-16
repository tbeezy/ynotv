import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { StremioMetaPreview } from '../../types/stremio';
import { scrobbler, TRAKT_CATALOG_DEFINITIONS, type TraktCatalogType } from '../../services/scrobbler';
import { useStremioHover } from '../../contexts/StremioHoverContext';
import { useStremioAddonStore } from '../../stores/stremioAddonStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  useSetStremioSelectedAddonId,
  useSetStremioSelectedCatalogId,
  useSetStremioSelectedCatalogType,
  useSetStremioSelectedCloudCatalogKey,
} from '../../stores/uiStore';
import './StremioHome.css';

const HIDDEN_CATALOG_IDS = new Set(['last-videos', 'calendar-videos']);

const cleanTitle = (title: string, type: 'trakt') => {
  if (type === 'trakt') {
    return title.replace(/^Trakt\s*—\s*/, '').replace(/^Trakt\s*/, '');
  }
  return title;
};

interface CloudCatalogEntry {
  key: string;
  title: string;
}

interface CloudCatalogDetailViewProps {
  cloudCatalogKey: string;
  onItemClick: (item: StremioMetaPreview) => void;
  onBack: () => void;
}

function parseCloudKey(key: string): { type: 'trakt' | 'trakt-list'; id: string } {
  if (key.startsWith('trakt-list-')) {
    return { type: 'trakt-list', id: key.slice('trakt-list-'.length) };
  }
  if (key.startsWith('trakt-')) {
    return { type: 'trakt', id: key.slice('trakt-'.length) };
  }
  return { type: 'trakt', id: key };
}

async function fetchCloudCatalogPage(key: string, page: number): Promise<{ items: StremioMetaPreview[]; hasMore: boolean }> {
  const parsed = parseCloudKey(key);
  if (parsed.type === 'trakt-list') {
    return scrobbler.fetchTraktListCatalog(parsed.id, page);
  }
  if (parsed.type === 'trakt') {
    return scrobbler.fetchTraktCatalog(parsed.id as TraktCatalogType, page);
  }
  return { items: [], hasMore: false };
}

export function CloudCatalogDetailView({ cloudCatalogKey, onItemClick, onBack }: CloudCatalogDetailViewProps) {
  useTranslation();
  const [items, setItems] = useState<StremioMetaPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [availableCatalogs, setAvailableCatalogs] = useState<CloudCatalogEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState(cloudCatalogKey);
  const { onCardMouseEnter, onCardMouseLeave, onCardClick } = useStremioHover();

  const addons = useStremioAddonStore((s) => s.enabledAddons);
  const setSelectedAddonId = useSetStremioSelectedAddonId();
  const setSelectedCatalogId = useSetStremioSelectedCatalogId();
  const setSelectedCatalogType = useSetStremioSelectedCatalogType();
  const setSelectedCloudCatalogKey = useSetStremioSelectedCloudCatalogKey();

  // Compute navigation filters (addon types)
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

  const hasTrakt = useMemo(() => availableCatalogs.some((c) => c.key.startsWith('trakt')), [availableCatalogs]);

  const typeOptions = useMemo(() => {
    const list = types.map((t) => ({
      value: t,
      label: t === 'series' ? i18n.t('stremio:series') : t.charAt(0).toUpperCase() + t.slice(1) + 's',
    }));
    if (hasTrakt) {
      list.push({ value: 'trakt', label: 'Trakt' });
    }
    return list;
  }, [types, hasTrakt]);

  const currentType = 'trakt';

  const filteredCatalogs = useMemo(() => {
    return availableCatalogs.filter((c) => c.key.startsWith(currentType));
  }, [availableCatalogs, currentType]);

  // Load available cloud catalogs from the settings store (single source of
  // truth — hydrated at boot, kept current by the setters).
  useEffect(() => {
    let active = true;
    const loadCatalogs = () => {
      const s = useSettingsStore.getState();
      const entries: CloudCatalogEntry[] = [];

      if (s.traktEnabled && s.traktAccessToken) {
        const enabledCatalogs: Record<string, boolean> = s.traktCatalogsEnabled || {};
        for (const def of TRAKT_CATALOG_DEFINITIONS) {
          if (enabledCatalogs[def.type] === true) {
            entries.push({ key: `trakt-${def.type}`, title: `Trakt ${def.label}` });
          }
        }

        const enabledLists: { id: string; name: string }[] = s.traktEnabledLists || [];
        for (const list of enabledLists) {
          entries.push({ key: `trakt-list-${list.id}`, title: `Trakt \u2014 ${list.name}` });
        }
      }

      if (active) {
        setAvailableCatalogs(entries);
      }
    };
    loadCatalogs();
    return () => { active = false; };
  }, []);

  // Fetch items whenever selectedKey or page changes
  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      const { items: fetched, hasMore: more } = await fetchCloudCatalogPage(selectedKey, page);
      if (active) {
        setItems(fetched);
        setHasMore(more);
        setLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, [selectedKey, page]);

  const handleCatalogChange = useCallback((newKey: string) => {
    setSelectedCloudCatalogKey(newKey);
    setSelectedKey(newKey);
    setPage(1);
  }, [setSelectedCloudCatalogKey]);

  const handleTypeChange = (newType: string) => {
    if (newType === 'trakt') {
      const firstOfNewType = availableCatalogs.find((c) => c.key.startsWith(newType));
      if (firstOfNewType) {
        setSelectedCloudCatalogKey(firstOfNewType.key);
        setSelectedKey(firstOfNewType.key);
        setPage(1);
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
    }
  };

  const handlePrevPage = useCallback(() => {
    setPage((p) => Math.max(1, p - 1));
  }, []);

  const handleNextPage = useCallback(() => {
    if (hasMore) setPage((p) => p + 1);
  }, [hasMore]);

  const currentEntry = availableCatalogs.find((c) => c.key === selectedKey);
  const title = currentEntry?.title || i18n.t('stremio:cloudCatalog');

  return (
    <div className="stremio-catalog-detail-view">
      <div style={{ padding: '24px' }}>
        <div className="stremio-discover-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <button
              className="stremio-row-see-all-btn"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', height: '36px' }}
              onClick={onBack}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
              </svg>
              {i18n.t('stremio:back')}
            </button>
            <h3 className="stremio-row-title" style={{ fontSize: '1.2rem' }}>{i18n.t('stremio:discover')}</h3>
          </div>

          <div className="stremio-discover-filters">
            {/* First dropdown: Type/Provider selector */}
            <select
              className="stremio-discover-select"
              value={currentType}
              onChange={(e) => handleTypeChange(e.target.value)}
            >
              {typeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            {/* Second dropdown: Catalog selector */}
            <select
              className="stremio-discover-select"
              value={selectedKey}
              onChange={(e) => handleCatalogChange(e.target.value)}
            >
              {filteredCatalogs.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {cleanTitle(entry.title, currentType)}
                </option>
              ))}
            </select>

            <div className="stremio-row-nav" style={{ marginLeft: '8px' }}>
              <button
                className="stremio-row-nav-btn"
                onClick={handlePrevPage}
                disabled={page <= 1}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.35)', margin: '0 8px', display: 'flex', alignItems: 'center' }}>
                {page}
              </span>
              <button
                className="stremio-row-nav-btn"
                onClick={handleNextPage}
                disabled={!hasMore}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="stremio-loading-text" style={{ padding: '80px 0' }}>{i18n.t('stremio:loadingCatalog')}</div>
        ) : items.length === 0 ? (
          <div className="stremio-loading-text" style={{ padding: '80px 0' }}>{i18n.t('stremio:noItemsInCatalog')}</div>
        ) : (
          <>
            <div className="stremio-meta-grid">
              {items.map((item, idx) => (
                <div
                  key={`${item.id}-${idx}`}
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
            <div className="stremio-loading-text" style={{ padding: '20px 0', textAlign: 'center' }}>
              {i18n.t('stremio:pageIndicator', { page })}{hasMore ? ` ${i18n.t('stremio:useArrowsToNavigate')}` : ''}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
