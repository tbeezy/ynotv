import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import type { IdentifyResolution, LocalEntry, LocalGroup, LocalSortKey, ScannedFile, SortDir } from '../../services/local-library/types';
import {
  addLocalEntries,
  groupLocal,
  parseFilename,
  extractEpisodeNumber,
  removeLocalEntries,
  sortGroups,
  updateLocalEntries,
  useLocalLibrary,
  localEntryToVodPlayInfo,
  addScannedFolder,
} from '../../services/local-library/local-library';
import { countNfoFor, clearSidecarCache } from '../../services/local-library/sidecars';
import { buildNfoEntry, buildTmdbEntry } from '../../services/local-library/scan';
import { markLocalMovieWatched, markLocalEpisodeWatched } from '../../services/local-library/local-watch';
import { useActiveTmdbToken } from '../../hooks/useTmdbLists';
import { PosterSizeSlider } from '../PosterSizeSlider';
import { useAutoLocalSync } from '../../services/local-library/auto-sync';
import { LocalMovieCard } from './LocalMovieCard';
import { LocalShowGroupCard } from './LocalShowGroupCard';
import { LocalEpisodesModal } from './LocalEpisodesModal';
import { LocalDetail } from './LocalDetail';
import { LocalFoldersModal } from './LocalFoldersModal';
import { IdentifyModal } from './IdentifyModal';
import { ScanModeModal, type ScanMode } from './ScanModeModal';
import type { VodPlayInfo } from '../../types/media';
import './LocalTab.css';

interface LocalTabProps {
  initialFilter?: 'all' | 'movies' | 'series';
  lockFilter?: boolean;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  onPlayVod?: (info: VodPlayInfo) => void;
  onOpenDetail?: (item: any) => void;
}

export function LocalTab({
  initialFilter = 'all',
  lockFilter = false,
  searchQuery: searchQueryProp,
  onSearchChange,
  onPlayVod,
  onOpenDetail,
}: LocalTabProps) {
  const { t } = useTranslation('vod');
  const items = useLocalLibrary();
  const tmdbToken = useActiveTmdbToken();

  const [activeFilter, setActiveFilter] = useState<'all' | 'movies' | 'series'>(initialFilter);
  const [internalSearchQuery, setInternalSearchQuery] = useState('');
  const searchQuery = searchQueryProp !== undefined ? searchQueryProp : internalSearchQuery;
  const handleSearchChange = useCallback((query: string) => {
    setInternalSearchQuery(query);
    onSearchChange?.(query);
  }, [onSearchChange]);
  const [sortKey, setSortKey] = useState<LocalSortKey>('added');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Poster Size state (persisted)
  const [posterSize, setPosterSize] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('localPosterSize');
      const num = saved ? parseInt(saved, 10) : NaN;
      return Number.isFinite(num) && num >= 100 && num <= 300 ? num : 170;
    } catch {
      return 170;
    }
  });

  const handlePosterSizeChange = useCallback((newSize: number) => {
    setPosterSize(newSize);
    try {
      localStorage.setItem('localPosterSize', String(newSize));
    } catch {
      /* ignore */
    }
  }, []);

  // Scan state
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number } | null>(null);
  const [pendingScanFiles, setPendingScanFiles] = useState<ScannedFile[] | null>(null);
  const [pendingNfoCount, setPendingNfoCount] = useState<number>(0);
  const [pendingFolderPath, setPendingFolderPath] = useState<string | null>(null);
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [foldersModalOpen, setFoldersModalOpen] = useState(false);

  // Modals / Details state
  const [identifyTarget, setIdentifyTarget] = useState<LocalEntry[] | null>(null);
  const [episodesModalTarget, setEpisodesModalTarget] = useState<{ head: LocalEntry; episodes: LocalEntry[] } | null>(null);
  const [selectedDetailGroup, setSelectedDetailGroup] = useState<LocalGroup | null>(null);

  // Toast
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  }, []);

  // Background folder sync on mount / interval
  useAutoLocalSync(
    tmdbToken,
    useCallback(
      (res: { added: number; removed: number }) => {
        if (res.added > 0 && res.removed > 0) {
          showToast(t('syncResult', { added: res.added, removed: res.removed }));
        } else if (res.added > 0) {
          showToast(t('addedNewItems', { count: res.added }));
        } else if (res.removed > 0) {
          showToast(t('cleanedMissingItems', { count: res.removed }));
        }
      },
      [showToast, t],
    ),
  );

  // Group items into movies & series
  const groups = useMemo(() => groupLocal(items), [items]);

  // Counts
  const movieCount = useMemo(() => groups.filter((g) => g.kind === 'movie').length, [groups]);
  const seriesCount = useMemo(() => groups.filter((g) => g.kind === 'show').length, [groups]);
  const needsReviewList = useMemo(() => items.filter((e) => e.needsReview), [items]);

  // Keep selected detail group fresh if underlying items update
  const currentDetailGroup = useMemo(() => {
    if (!selectedDetailGroup) return null;
    if (selectedDetailGroup.kind === 'movie') {
      const match = items.find((i) => i.id === selectedDetailGroup.entry.id);
      return match ? { kind: 'movie' as const, entry: match } : null;
    }
    const matchGroup = groups.find((g) => g.kind === 'show' && g.key === selectedDetailGroup.key);
    return matchGroup ?? null;
  }, [selectedDetailGroup, items, groups]);

  // Filter & Sort
  const filteredGroups = useMemo(() => {
    const effFilter = lockFilter ? initialFilter : activeFilter;
    let list = groups;

    if (effFilter === 'movies') {
      list = list.filter((g) => g.kind === 'movie');
    } else if (effFilter === 'series') {
      list = list.filter((g) => g.kind === 'show');
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((g) => {
        const title = (g.kind === 'movie' ? g.entry.title : g.head.title) || '';
        return title.toLowerCase().includes(q);
      });
    }

    return sortGroups(list, sortKey, sortDir);
  }, [groups, lockFilter, initialFilter, activeFilter, searchQuery, sortKey, sortDir]);

  // Play handler
  const handlePlayEntry = useCallback((entry: LocalEntry, seriesGroup?: { key: string; head: LocalEntry }) => {
    const playInfo = localEntryToVodPlayInfo(entry, seriesGroup);
    if (onPlayVod) {
      onPlayVod(playInfo);
    } else {
      // Dispatch global playback event
      window.dispatchEvent(new CustomEvent('ynotv:stremio-play', { detail: playInfo }));
    }
  }, [onPlayVod]);

  // Detail handler: cross-link matched items to an external detail view when provided
  const handleOpenDetail = useCallback((group: LocalGroup) => {
    const entry = group.kind === 'movie' ? group.entry : group.head;
    if (onOpenDetail && (entry.tmdbId != null || entry.imdbId != null)) {
      onOpenDetail(entry);
    } else {
      setSelectedDetailGroup(group);
    }
  }, [onOpenDetail]);

  // Folder picking & scan initiation
  const handleAddFolder = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('selectFolderDialogTitle', 'Select Folder with Movies or Shows'),
      });
      if (!selected || typeof selected !== 'string') return;

      setScanning(true);
      clearSidecarCache();
      const files = await invoke<ScannedFile[]>('scan_local_folder', { folder: selected });

      if (!files || files.length === 0) {
        setScanning(false);
        showToast(t('noVideoFilesFound'));
        return;
      }

      addScannedFolder(selected);
      setPendingFolderPath(selected);

      const nfos = await countNfoFor(files.map((f) => f.path));
      if (nfos > 0) {
        setPendingScanFiles(files);
        setPendingNfoCount(nfos);
        setScanModalOpen(true);
        setScanning(false);
      } else {
        await executeScan(files, 'tmdb');
      }
    } catch (err: any) {
      console.error('[LocalTab] Folder scan failed:', err);
      setScanning(false);
      showToast(err?.message || t('folderScanFailed'));
    }
  }, [showToast, t]);

  const handleRescanSpecificFolder = useCallback(async (folderPath: string) => {
    try {
      clearSidecarCache();
      const files = await invoke<ScannedFile[]>('scan_local_folder', { folder: folderPath });
      if (!files || files.length === 0) {
        showToast(t('noVideoFilesFound'));
        return;
      }
      addScannedFolder(folderPath);
      await executeScan(files, 'tmdb');
    } catch (err: any) {
      console.error('[LocalTab] Rescan failed:', err);
      showToast(err?.message || t('rescanFailed'));
    }
  }, [showToast, t]);

  const executeScan = async (files: ScannedFile[], mode: ScanMode) => {
    setScanning(true);
    setScanProgress({ current: 0, total: files.length });
    const parsed = files.map((f) => ({ file: f, info: parseFilename(f.filename) }));

    const built: LocalEntry[] = [];
    let cur = 0;
    for (const { file, info } of parsed) {
      cur += 1;
      setScanProgress({ current: cur, total: files.length });
      try {
        const entry =
          mode === 'nfo'
            ? await buildNfoEntry(file, info, tmdbToken)
            : await buildTmdbEntry(file, info, tmdbToken);
        built.push(entry);
      } catch {
        built.push({
          id: file.path,
          path: file.path,
          filename: file.filename,
          title: info.title,
          year: info.year,
          type: info.type,
          resolution: info.resolution,
          addedAt: Date.now(),
          needsReview: true,
        });
      }
    }

    addLocalEntries(built);
    setScanning(false);
    setScanProgress(null);
    setPendingScanFiles(null);
    setPendingFolderPath(null);
    showToast(t('addedItemsToLibrary', { count: built.length }));
  };

  const handleScanModePick = (mode: ScanMode) => {
    setScanModalOpen(false);
    if (pendingScanFiles) {
      void executeScan(pendingScanFiles, mode);
    }
  };

  // Identify resolution
  const handleIdentifyResolved = useCallback((ids: string[], resolution: IdentifyResolution) => {
    updateLocalEntries(ids, (entry) => {
      const epInfo = extractEpisodeNumber(entry.filename);
      const epNum = entry.episode ?? epInfo?.episode ?? null;
      const seasonNum = entry.season ?? epInfo?.season ?? 1;

      return {
        tmdbId: resolution.tmdbId,
        imdbId: resolution.imdbId,
        poster: resolution.poster,
        backdrop: resolution.backdrop,
        title: resolution.title,
        year: resolution.year,
        type: resolution.type,
        overview: resolution.overview ?? null,
        rating: resolution.rating ?? null,
        runtime: resolution.runtime ?? null,
        season: resolution.type === 'show' ? seasonNum : null,
        episode: resolution.type === 'show' ? epNum : null,
        needsReview: false,
      };
    });
    setSelectedIds(new Set());
    setSelectMode(false);
    showToast(
      ids.length > 1
        ? t('matchedFilesAs', { count: ids.length, title: resolution.title })
        : t('matchUpdated')
    );
  }, [showToast, t]);

  // Selection handlers
  const handleToggleSelectId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleToggleSelectGroup = useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      if (allSelected) {
        for (const id of ids) next.delete(id);
      } else {
        for (const id of ids) next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(items.map((i) => i.id)));
  }, [items]);

  const handleInvertSelect = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const it of items) {
        if (!prev.has(it.id)) next.add(it.id);
      }
      return next;
    });
  }, [items]);

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    removeLocalEntries(Array.from(selectedIds));
    setSelectedIds(new Set());
    setSelectMode(false);
    showToast(t('removedSelectedItems'));
  }, [selectedIds, showToast, t]);

  const handleBulkMarkWatched = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const selectedItems = items.filter((i) => selectedIds.has(i.id));
    for (const item of selectedItems) {
      if (item.type === 'movie') {
        await markLocalMovieWatched(item, true);
      } else {
        await markLocalEpisodeWatched(item, item.title, true);
      }
    }
    showToast(t('markedItemsWatched', { count: selectedItems.length }));
  }, [selectedIds, items, showToast, t]);

  return (
    <div className="local-tab-container">
      {/* Top Toolbar */}
      <div className="local-toolbar">
        <div className="local-toolbar__left">
          {!lockFilter && (
            <div className="local-type-pills">
              <button
                type="button"
                className={`local-type-pill ${activeFilter === 'all' ? 'active' : ''}`}
                onClick={() => setActiveFilter('all')}
              >
                {t('all', 'All')}
                <span className="local-type-pill__count">{items.length}</span>
              </button>
              <button
                type="button"
                className={`local-type-pill ${activeFilter === 'movies' ? 'active' : ''}`}
                onClick={() => setActiveFilter('movies')}
              >
                {t('movies', 'Movies')}
                <span className="local-type-pill__count">{movieCount}</span>
              </button>
              <button
                type="button"
                className={`local-type-pill ${activeFilter === 'series' ? 'active' : ''}`}
                onClick={() => setActiveFilter('series')}
              >
                {t('series', 'Series')}
                <span className="local-type-pill__count">{seriesCount}</span>
              </button>
            </div>
          )}

          {/* Search Box */}
          <div className="local-toolbar__search-wrap">
            <span className="local-toolbar__search-icon">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={t('searchPlaceholder', 'Search local media...')}
              className="local-toolbar__search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="local-toolbar__search-clear"
                onClick={() => handleSearchChange('')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="local-toolbar__right">
          {/* Sort Dropdown */}
          <select
            className="local-select-dropdown"
            value={`${sortKey}_${sortDir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split('_') as [LocalSortKey, SortDir];
              setSortKey(key);
              setSortDir(dir);
            }}
          >
            <option value="added_desc">{t('recentlyAdded', 'Recently Added')}</option>
            <option value="name_asc">{t('nameAZ', 'Name (A-Z)')}</option>
            <option value="name_desc">{t('nameZA', 'Name (Z-A)')}</option>
            <option value="rating_desc">{t('highestRated', 'Highest Rated')}</option>
            <option value="year_desc">{t('newestFirst', 'Release Year (Newest)')}</option>
            <option value="year_asc">{t('oldestFirst', 'Release Year (Oldest)')}</option>
          </select>

          {/* Poster Size Slider */}
          <PosterSizeSlider value={posterSize} onChange={handlePosterSizeChange} />

          {/* Manage Folders Button */}
          <button
            type="button"
            className="local-btn local-btn--secondary"
            onClick={() => setFoldersModalOpen(true)}
            title={t('manageFolders', 'Manage Folders')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            {t('folders', 'Folders')}
          </button>

          {/* Select Mode Toggle */}
          {items.length > 0 && (
            <button
              type="button"
              className={`local-btn ${selectMode ? 'local-btn--active' : 'local-btn--secondary'}`}
              onClick={() => {
                setSelectMode(!selectMode);
                setSelectedIds(new Set());
              }}
            >
              {selectMode ? t('done', 'Done') : t('select', 'Select')}
            </button>
          )}

          {/* Add Folder Button */}
          <button
            type="button"
            className="local-btn local-btn--primary"
            onClick={handleAddFolder}
            disabled={scanning}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
            {scanning ? t('scanning', 'Scanning...') : t('addFolder', 'Add folder')}
          </button>
        </div>
      </div>

      {/* Needs Review Alert Banner */}
      {needsReviewList.length > 0 && !selectMode && (
        <div className="local-review-banner">
          <div
            className="local-review-banner__left"
            onClick={() => {
              const first = needsReviewList[0];
              const matchingEpisodes = items.filter(
                (i) => i.type === 'show' && i.title === first.title,
              );
              setIdentifyTarget(matchingEpisodes.length > 0 ? matchingEpisodes : [first]);
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="local-review-banner__text">
              {t('needsReviewBanner', '{{count}} titles need review — help us identify them.', {
                count: needsReviewList.length,
              })}
            </span>
          </div>

          <div className="local-review-banner__actions">
            {needsReviewList.length > 1 && (
              <button
                type="button"
                className="local-review-banner__btn local-review-banner__btn--batch"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedIds(new Set(needsReviewList.map((i) => i.id)));
                  setIdentifyTarget(needsReviewList);
                }}
                title={t('batchReviewAll', 'Identify all review items into one series')}
              >
                {t('batchReview', 'Batch Match Series')}
              </button>
            )}
            <button
              type="button"
              className="local-review-banner__btn"
              onClick={(e) => {
                e.stopPropagation();
                const first = needsReviewList[0];
                const matchingEpisodes = items.filter(
                  (i) => i.type === 'show' && i.title === first.title,
                );
                setIdentifyTarget(matchingEpisodes.length > 0 ? matchingEpisodes : [first]);
              }}
            >
              {t('review', 'Review')}
            </button>
          </div>
        </div>
      )}

      {/* Bulk Action Bar during Select Mode */}
      {selectMode && (
        <div className="local-bulk-bar">
          <span className="local-bulk-bar__count">
            {selectedIds.size} {t('selected', 'selected')}
          </span>
          <div className="local-bulk-bar__actions">
            <button
              type="button"
              className="local-btn local-btn--secondary"
              onClick={handleSelectAll}
            >
              {t('selectAll', 'Select all')}
            </button>
            <button
              type="button"
              className="local-btn local-btn--secondary"
              onClick={handleInvertSelect}
            >
              {t('invertSelection', 'Invert')}
            </button>
            <button
              type="button"
              className="local-btn local-btn--primary"
              disabled={selectedIds.size === 0}
              onClick={() => {
                const selectedItems = items.filter((i) => selectedIds.has(i.id));
                if (selectedItems.length > 0) {
                  setIdentifyTarget(selectedItems);
                }
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: '5px' }}>
                <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" />
              </svg>
              {selectedIds.size > 1 ? t('matchAsSeries', 'Match as Series') : t('identify', 'Identify')}
            </button>
            <button
              type="button"
              className="local-btn local-btn--secondary"
              onClick={handleBulkMarkWatched}
              disabled={selectedIds.size === 0}
            >
              {t('markWatched', 'Mark as watched')}
            </button>
            <button
              type="button"
              className="local-btn local-btn--secondary"
              style={{ color: '#ef4444' }}
              onClick={handleBulkDelete}
              disabled={selectedIds.size === 0}
            >
              {t('remove', 'Remove')}
            </button>
            <button
              type="button"
              className="local-btn local-btn--secondary"
              onClick={() => {
                setSelectMode(false);
                setSelectedIds(new Set());
              }}
            >
              {t('done', 'Done')}
            </button>
          </div>
        </div>
      )}

      {/* Scan Progress Alert */}
      {scanning && scanProgress && (
        <div style={{ background: 'var(--surface-color, rgba(40,40,40,0.8))', padding: '14px 20px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '14px', border: '1px solid var(--surface-border)' }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12.5px', marginBottom: '6px' }}>
              <span>{t('scanningMediaFiles', 'Scanning media files...')}</span>
              <span>{scanProgress.current} / {scanProgress.total}</span>
            </div>
            <div style={{ height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(scanProgress.current / scanProgress.total) * 100}%`, background: 'var(--accent-primary, #00d4ff)', transition: 'width 0.2s' }} />
            </div>
          </div>
        </div>
      )}

      {/* Main Content: Grid or Empty State */}
      {items.length === 0 && !scanning ? (
        <div className="local-empty-state">
          <div className="local-empty-state__icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </div>
          <h3 className="local-empty-state__title">
            {t('emptyLocalTitle', 'Add files from your computer')}
          </h3>
          <p className="local-empty-state__desc">
            {t('emptyLocalDesc', 'Point ynoTV at a folder. We scan it for movies and shows, parse titles from filenames, and enrich them with TMDB so they look the same as everything else here. We just remember the path; nothing is copied or moved.')}
          </p>
          <button
            type="button"
            className="local-btn local-btn--primary"
            style={{ padding: '0 24px', height: '42px', fontSize: '13.5px' }}
            onClick={handleAddFolder}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            {t('chooseFolder', 'Choose folder')}
          </button>
        </div>
      ) : (
        <div
          className="local-grid"
          style={{ '--local-poster-size': `${posterSize}px` } as React.CSSProperties}
        >
          {filteredGroups.map((g) => {
            if (g.kind === 'movie') {
              return (
                <LocalMovieCard
                  key={g.entry.id}
                  entry={g.entry}
                  selectMode={selectMode}
                  isSelected={selectedIds.has(g.entry.id)}
                  onToggleSelect={handleToggleSelectId}
                  onPlay={handlePlayEntry}
                  onOpenDetail={() => handleOpenDetail(g)}
                  onFixMatch={(entry) => setIdentifyTarget([entry])}
                />
              );
            }
            return (
              <LocalShowGroupCard
                key={g.key}
                head={g.head}
                episodes={g.episodes}
                selectMode={selectMode}
                isSelected={g.episodes.every((e) => selectedIds.has(e.id))}
                onToggleSelect={handleToggleSelectGroup}
                onOpenEpisodes={(head, episodes) => setEpisodesModalTarget({ head, episodes })}
                onOpenDetail={() => handleOpenDetail(g)}
                onFixMatch={(episodes) => setIdentifyTarget(episodes)}
              />
            );
          })}
        </div>
      )}

      {/* Episodes Picker Modal */}
      {episodesModalTarget && (
        <LocalEpisodesModal
          head={episodesModalTarget.head}
          episodes={episodesModalTarget.episodes}
          onClose={() => setEpisodesModalTarget(null)}
          onPlayEpisode={(ep) => {
            handlePlayEntry(ep, { key: episodesModalTarget.head.title, head: episodesModalTarget.head });
            setEpisodesModalTarget(null);
          }}
        />
      )}

      {/* Identify / Match Fix Modal */}
      {identifyTarget && (
        <IdentifyModal
          target={identifyTarget}
          onClose={() => setIdentifyTarget(null)}
          onResolved={handleIdentifyResolved}
        />
      )}

      {/* Scan Mode Modal */}
      <ScanModeModal
        isOpen={scanModalOpen}
        nfoCount={pendingNfoCount}
        onPick={handleScanModePick}
        onClose={() => {
          setScanModalOpen(false);
          setPendingScanFiles(null);
          setPendingFolderPath(null);
        }}
      />

      {/* Folders Management Modal */}
      <LocalFoldersModal
        isOpen={foldersModalOpen}
        onClose={() => setFoldersModalOpen(false)}
        onRescanFolder={handleRescanSpecificFolder}
        onAddNewFolder={async () => {
          setFoldersModalOpen(false);
          await handleAddFolder();
        }}
      />

      {/* Full Page Detail View for Selected Item */}
      {currentDetailGroup && (
        <LocalDetail
          group={currentDetailGroup}
          onClose={() => setSelectedDetailGroup(null)}
          onPlay={(entry, seriesGroup) => handlePlayEntry(entry, seriesGroup)}
          onFixMatch={(target) => setIdentifyTarget(target)}
          onRemove={(ids) => {
            removeLocalEntries(ids);
            setSelectedDetailGroup(null);
            showToast(t('itemRemoved'));
          }}
        />
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className="local-toast">
          {toastMessage}
        </div>
      )}
    </div>
  );
}
