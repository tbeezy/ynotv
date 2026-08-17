import { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStremioLibraryStore, type LibraryItem } from '../../stores/stremioLibraryStore';
import { useStremioWatchStore } from '../../stores/stremioWatchStore';
import { useStremioAuthStore } from '../../stores/stremioAuthStore';
import type { StremioMeta } from '../../types/stremio';
import { useStremioAddonStore } from '../../stores/stremioAddonStore';
import { fetchMeta } from '../../services/stremio-addon';
import { useStremioHover } from '../../contexts/StremioHoverContext';
import type { StremioMetaPreview } from '../../types/stremio';
import { LocalTab } from '../local/LocalTab';
import './StremioLibrary.css';

interface StremioLibraryProps {
  onItemClick: (meta: StremioMeta) => void;
}

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export function StremioLibrary({ onItemClick }: StremioLibraryProps) {
  const { t } = useTranslation('stremio');
  const library = useStremioLibraryStore((s) => s.library);
  const updateLibraryItem = useStremioLibraryStore((s) => s.updateLibraryItem);
  const addons = useStremioAddonStore((s) => s.enabledAddons);
  const addonsKey = addons.map((a) => `${a.id}:${a.enabled !== false}`).join(',');
  const episodeProgress = useStremioWatchStore((s) => s.episodeProgress || {});

  const authStore = useStremioAuthStore();
  const isSyncActive = authStore.authKey && authStore.syncLibrary;
  const cloudLibraryItems = authStore.cloudLibraryItems || [];

  const [search, setSearch] = useState('');
  const [selectedType, setSelectedType] = useState('All');
  const [sortBy, setSortBy] = useState<'added' | 'name' | 'rating' | 'year'>('added');
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'watchlist' | 'history' | 'local'>('watchlist');

  const history = useStremioWatchStore((s) => s.history || []);

  // Refresh stale library items in the background
  useEffect(() => {
    const stale = library.filter(
      (item) => item.type === 'series' && (!item.lastChecked || Date.now() - item.lastChecked > REFRESH_INTERVAL_MS)
    );
    if (stale.length === 0) return;

    let cancelled = false;
    const refresh = async () => {
      setRefreshing(true);
      for (const item of stale) {
        if (cancelled) break;
        const addon = addons.find((a) => a.manifest.catalogs?.some((c) => c.type === item.type));
        if (!addon) continue;
        try {
          const meta = await fetchMeta([addon], item.type, item.id);
          if (meta && meta.videos && !cancelled) {
            updateLibraryItem(item.id, {
              videos: meta.videos,
              videoCount: meta.videos.length,
              lastChecked: Date.now(),
            });
          }
        } catch {
          // Skip refresh failures
        }
      }
      if (!cancelled) setRefreshing(false);
    };
    refresh();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, addonsKey, updateLibraryItem]);

  const getNewCount = useCallback((item: LibraryItem): number => {
    if (item.type !== 'series' || !item.videos) return 0;
    return item.videos.filter((v) => {
      if (v.season === undefined || v.episode === undefined) return false;
      return !episodeProgress[v.id]?.finished;
    }).length;
  }, [episodeProgress]);

  const filteredItems = useMemo(() => {
    let items: LibraryItem[] = [];
    if (isSyncActive) {
      items = cloudLibraryItems
        .filter((i) => {
          if (i.removed) return false;
          if (i.state?.flaggedWatched === 1) return false;
          if ((i.state?.timeOffset ?? 0) > 0) return false;
          if (i.temp) return false;
          return true;
        })
        .map((i) => {
          const local = library.find((x) => x.id === i._id);
          return {
            id: i._id,
            type: i.type,
            name: i.name,
            poster: i.poster,
            posterShape: i.posterShape,
            imdbRating: local?.imdbRating,
            genres: local?.genres,
            year: local?.year,
            releaseInfo: local?.releaseInfo,
            description: local?.description,
            videos: local?.videos,
            videoCount: local?.videoCount,
            lastChecked: local?.lastChecked,
          } as LibraryItem;
        });
    } else {
      items = [...library];
    }

    if (selectedType !== 'All') {
      const typeLower = selectedType.toLowerCase();
      if (typeLower === 'movies') {
        items = items.filter((item) => item.type === 'movie');
      } else if (typeLower === 'series') {
        items = items.filter((item) => item.type === 'series');
      } else {
        items = items.filter((item) => item.type !== 'movie' && item.type !== 'series');
      }
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter((item) => item.name.toLowerCase().includes(q));
    }

    items.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'rating': {
          const rA = a.imdbRating ? parseFloat(a.imdbRating) : 0;
          const rB = b.imdbRating ? parseFloat(b.imdbRating) : 0;
          return rB - rA;
        }
        case 'year': {
          const yA = a.year ? parseInt(String(a.year), 10) : (a.releaseInfo ? parseInt(String(a.releaseInfo), 10) : 0);
          const yB = b.year ? parseInt(String(b.year), 10) : (b.releaseInfo ? parseInt(String(b.releaseInfo), 10) : 0);
          return yB - yA;
        }
        case 'added':
        default:
          return 0;
      }
    });

    return items;
  }, [library, selectedType, search, sortBy, isSyncActive, cloudLibraryItems]);

  const filteredHistory = useMemo(() => {
    let items: any[] = [...history];

    if (isSyncActive) {
      const existingIds = new Set(items.map((i) => i.metaId));
      for (const cItem of cloudLibraryItems) {
        if (cItem.removed && !cItem.temp) continue;
        if (cItem.state?.flaggedWatched !== 1 && (cItem.state?.timeOffset ?? 0) <= 0) continue;
        if (existingIds.has(cItem._id)) continue;

        const local = library.find((x) => x.id === cItem._id);
        const progressFraction =
          cItem.state?.duration && cItem.state?.timeOffset
            ? Math.min(1.0, cItem.state.timeOffset / cItem.state.duration)
            : 0;

        let lastSeason = cItem.state?.season;
        let lastEpisode = cItem.state?.episode;
        let nextVideoId: string | undefined;
        let nextSeason: number | undefined;
        let nextEpisode: number | undefined;

        if (cItem.type === 'series') {
          if (cItem.state?.video_id) {
            const parts = cItem.state.video_id.split(':');
            if (parts.length >= 3) {
              lastSeason = parseInt(parts[parts.length - 2], 10);
              lastEpisode = parseInt(parts[parts.length - 1], 10);
            }
          }

          if (lastSeason !== undefined && lastEpisode !== undefined && local?.videos) {
            const sorted = [...local.videos].sort((a, b) => {
              if ((a.season ?? 0) !== (b.season ?? 0)) return (a.season ?? 0) - (b.season ?? 0);
              return (a.episode ?? 0) - (b.episode ?? 0);
            });
            const idx = sorted.findIndex((v) => v.id === cItem.state?.video_id);
            const isFinished = progressFraction >= 0.9;
            if (isFinished && idx >= 0 && idx < sorted.length - 1) {
              const nxt = sorted[idx + 1];
              nextVideoId = nxt.id;
              nextSeason = nxt.season;
              nextEpisode = nxt.episode;
            }
          }
        }

        items.push({
          metaId: cItem._id,
          type: cItem.type,
          name: cItem.name,
          poster: cItem.poster || null,
          progressFraction,
          lastWatchedVideoId: cItem.state?.video_id,
          lastSeason,
          lastEpisode,
          nextVideoId,
          nextSeason,
          nextEpisode,
          watchedAt: cItem._mtime ? Date.parse(cItem._mtime) : Date.now(),
        });
      }
    }

    if (selectedType !== 'All') {
      const typeMap: Record<string, string> = {
        Movies: 'movie',
        Series: 'series',
      };
      const mappedType = typeMap[selectedType] || selectedType.toLowerCase();
      items = items.filter((item) => item.type === mappedType);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter((item) => item.name.toLowerCase().includes(q));
    }

    items.sort((a, b) => {
      if (sortBy === 'name') {
        return a.name.localeCompare(b.name);
      }
      return b.watchedAt - a.watchedAt;
    });

    return items;
  }, [history, search, selectedType, sortBy, isSyncActive, cloudLibraryItems, library]);

  const handleCardClick = async (item: LibraryItem) => {
    const addon = addons.find((a) => a.manifest.catalogs?.some((c) => c.type === item.type));
    if (addon) {
      const meta = await fetchMeta([addon], item.type, item.id);
      if (meta) onItemClick(meta);
    }
  };

  const handleHistoryCardClick = async (entry: any) => {
    const addon = addons.find((a) => a.manifest.catalogs?.some((c) => c.type === entry.type));
    if (addon) {
      const meta = await fetchMeta([addon], entry.type, entry.metaId);
      if (meta) {
        import('../../stores/uiStore').then(({ useUIStore }) => {
          if (entry.type === 'series') {
            const targetSeason = entry.nextSeason != null ? entry.nextSeason : entry.lastSeason;
            if (targetSeason != null) {
              useUIStore.getState().setStremioSelectedSeason(targetSeason);
            }
            const targetVideoId = entry.nextVideoId || entry.lastWatchedVideoId;
            if (targetVideoId) {
              useUIStore.getState().setStremioPreselectVideoId(targetVideoId);
            }
          }
        });
        onItemClick(meta);
      }
    }
  };

  const { onCardMouseEnter, onCardMouseLeave, onCardClick } = useStremioHover();

  return (
    <div className="stremio-library">
      <div className="stremio-library-header">
        <div className="stremio-library-title-group">
          <h2 className="stremio-library-title">{t('library')}</h2>
          <div className="stremio-library-tabs">
            <button
              className={`stremio-library-tab ${activeTab === 'watchlist' ? 'active' : ''}`}
              onClick={() => setActiveTab('watchlist')}
            >
              Watchlist
            </button>
            <button
              className={`stremio-library-tab ${activeTab === 'history' ? 'active' : ''}`}
              onClick={() => setActiveTab('history')}
            >
              History
            </button>
            <button
              className={`stremio-library-tab ${activeTab === 'local' ? 'active' : ''}`}
              onClick={() => setActiveTab('local')}
            >
              {t('local', 'Local')}
            </button>
          </div>
          {refreshing && <span className="stremio-library-refreshing"> Refreshing...</span>}
        </div>
        {activeTab !== 'local' && (
          <div className="stremio-library-controls">
            <input
              className="stremio-library-search"
              type="text"
              placeholder={t('searchLibrary')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="stremio-library-select"
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
            >
              <option value="All">{t('allTypes')}</option>
              <option value="Movies">{t('movies')}</option>
              <option value="Series">{t('series')}</option>
              {activeTab === 'watchlist' && <option value="Other">{t('other')}</option>}
            </select>
            <select
              className="stremio-library-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
            >
              {activeTab === 'watchlist' ? (
                <>
                  <option value="added">{t('recentlyAdded')}</option>
                  <option value="name">A-Z</option>
                  <option value="rating">{t('imdbRating')}</option>
                  <option value="year">{t('releaseYear')}</option>
                </>
              ) : (
                <>
                  <option value="recent">{t('recentlyWatched')}</option>
                  <option value="name">A-Z</option>
                </>
              )}
            </select>
          </div>
        )}
      </div>

      {activeTab === 'local' ? (
        <LocalTab
          initialFilter="all"
          lockFilter={false}
          onOpenDetail={(item) => {
            const tmdbOrImdb = item.imdbId || (item.tmdbId ? `tmdb:${item.tmdbId}` : null);
            if (tmdbOrImdb) {
              const itemType = item.type === 'show' ? 'series' : 'movie';
              const addon = addons.find((a) => a.manifest.catalogs?.some((c) => c.type === itemType));
              if (addon) {
                fetchMeta([addon], itemType, tmdbOrImdb).then((meta) => {
                  if (meta) onItemClick(meta);
                });
              }
            }
          }}
        />
      ) : activeTab === 'watchlist' ? (
        filteredItems.length === 0 ? (
          <div className="stremio-library-empty">
            {library.length === 0
              ? 'Your watchlist is empty. Go discover and add items to your library!'
              : 'No watchlist items match your search and filter criteria.'}
          </div>
        ) : (
          <div className="stremio-library-grid">
            {filteredItems.map((item, idx) => {
              const newCount = item.type === 'series' ? getNewCount(item) : 0;
              return (
                <div
                  key={`${item.id}-${idx}`}
                  className="stremio-meta-card"
                  onMouseEnter={(e) => onCardMouseEnter(item as StremioMetaPreview, e.currentTarget, e)}
                  onMouseLeave={onCardMouseLeave}
                  onClick={() => {
                    onCardClick();
                    handleCardClick(item);
                  }}
                >
                  {item.poster && (
                    <div className="stremio-library-poster-wrap">
                      <img
                        className="stremio-meta-poster"
                        src={item.poster}
                        alt={item.name}
                        loading="lazy"
                      />
                      {newCount > 0 && (
                        <div className="stremio-library-new-badge">
                          {newCount}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="stremio-meta-card-info">
                    <div className="stremio-meta-card-title">{item.name}</div>
                    {item.imdbRating && <div className="stremio-meta-card-rating">★ {item.imdbRating}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        filteredHistory.length === 0 ? (
          <div className="stremio-library-empty">
            {history.length === 0
              ? 'Your watch history is empty.'
              : 'No history items match your search and filter criteria.'}
          </div>
        ) : (
          <div className="stremio-library-grid">
            {filteredHistory.map((entry) => {
              const isSeries = entry.type === 'series';
              const hasNext = isSeries && entry.nextVideoId != null;
              const progressPercent = Math.round(entry.progressFraction * 100);
              const showProgress = !hasNext && progressPercent > 2 && progressPercent < 98;
              let badge: string | null = null;
              if (isSeries && hasNext && entry.nextSeason != null && entry.nextEpisode != null) {
                badge = `▶ S${entry.nextSeason} E${entry.nextEpisode}`;
              } else if (isSeries && entry.lastSeason != null && entry.lastEpisode != null) {
                badge = `S${entry.lastSeason} E${entry.lastEpisode}`;
              }

              return (
                <div
                  key={entry.metaId}
                  className="stremio-meta-card"
                  onMouseEnter={(e) => {
                    const previewItem: StremioMetaPreview = {
                      id: entry.metaId,
                      type: entry.type,
                      name: entry.name,
                      poster: entry.poster || undefined,
                    };
                    onCardMouseEnter(previewItem, e.currentTarget, e);
                  }}
                  onMouseLeave={onCardMouseLeave}
                  onClick={() => {
                    onCardClick();
                    handleHistoryCardClick(entry);
                  }}
                >
                  {entry.poster && (
                    <div className="stremio-library-poster-wrap">
                      <img
                        className="stremio-meta-poster"
                        src={entry.poster}
                        alt={entry.name}
                        loading="lazy"
                      />
                      {showProgress && (
                        <div className="stremio-library-progress-track">
                          <div
                            className="stremio-library-progress-fill"
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                      )}
                      {badge && (
                        <div className={`stremio-library-ep-badge${hasNext ? ' next' : ''}`}>
                          {badge}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="stremio-meta-card-info">
                    <div className="stremio-meta-card-title">{entry.name}</div>
                    {hasNext ? (
                      <div className="stremio-library-card-sub next">{t('nextEpisode')}</div>
                    ) : (
                      showProgress && (
                        <div className="stremio-library-card-sub">{t('percentWatched', { percent: progressPercent })}</div>
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}