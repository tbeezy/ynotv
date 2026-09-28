import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { VirtualGrid, type VirtualGridHandle } from '../common/VirtualGrid';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import type { FolderType, IdentifyResolution, LocalEntry, LocalGroup, LocalSortKey, ScannedFile, SortDir } from '../../services/local-library/types';
import {
  addLocalEntries,
  groupLocal,
  parseFilename,
  readLocalLibrary,
  readScannedFolders,
  useScannedFolders,
  extractEpisodeNumber,
  removeLocalEntries,
  sortGroups,
  updateLocalEntries,
  useLocalLibrary,
  localShowKey,
  localEntryToVodPlayInfo,
  localEntryToStoredMovie,
  localGroupToStoredSeries,
  localEntryToStoredEpisode,
  addScannedFolder,
  findScannedFolder,
  ensureLocalLibraryLoaded,
  persistLocalEntryIncremental,
  hasUndo,
  onUndoChange,
  undoLocalChange,
  markEntriesAvailability,
} from '../../services/local-library/local-library';
import { countNfoFor, clearSidecarCache } from '../../services/local-library/sidecars';
import {
  buildNfoEntryForFolder,
  buildTmdbEntry,
  buildTmdbEntryForFolder,
  clearTmdbMatchCache,
  invalidateTmdbMatchCache,
  invalidateTmdbIdMatchCache,
  refreshTmdbEntry,
} from '../../services/local-library/scan';
import {
  readScanStateSync,
  loadScanState,
  writeScanState,
  clearScanState,
  loadScanFiles,
  writeScanFiles,
  clearScanFiles,
} from '../../services/local-library/scan-state';
import { markLocalMovieWatched, markLocalEpisodeWatched } from '../../services/local-library/local-watch';
import { useActiveTmdbToken } from '../../hooks/useTmdbLists';
import { useVodFavoritesStore } from '../../stores/vodFavoritesStore';
import { useAlphabetIndex, useCurrentLetter } from '../../hooks/useVod';
import { useScrollMemory } from '../../hooks/useScrollMemory';
import { preloadPosters, cancelPosterPreload } from './posterPreload';
import { PosterSizeSlider } from '../PosterSizeSlider';
import { useAutoLocalSync } from '../../services/local-library/auto-sync';
import { LocalMovieCard } from './LocalMovieCard';
import { LocalShowGroupCard } from './LocalShowGroupCard';
import { LocalEpisodesModal } from './LocalEpisodesModal';
import { LocalDetail } from './LocalDetail';
import { LocalFoldersModal } from './LocalFoldersModal';
import { FileNotFoundModal } from './FileNotFoundModal';
import { CleanUnavailableModal } from './CleanUnavailableModal';
import { IdentifyModal } from './IdentifyModal';
import { ReviewUnmatchedModal } from './ReviewUnmatchedModal';
import { ScanModeModal, type ScanMode } from './ScanModeModal';
import { AlphabetRail } from '../vod/AlphabetRail';
import { AddToPlaylistModal } from '../vod/AddToPlaylistModal';
import type { StoredEpisode, StoredMovie, StoredSeries } from '../../db';
import type { VodPlayInfo } from '../../types/media';
import './LocalTab.css';

function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Block a scan worker while the scan is paused. In-flight TMDB lookups are
// allowed to finish; each worker then waits here before pulling the next file,
// so no new requests start until the user resumes. Resolves immediately on
// abort so Stop works even while paused.
function waitWhilePaused(pausedRef: { current: boolean }, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!pausedRef.current || signal.aborted) return resolve();
    const id = setInterval(() => {
      if (!pausedRef.current || signal.aborted) {
        clearInterval(id);
        resolve();
      }
    }, 150);
    signal.addEventListener(
      'abort',
      () => {
        clearInterval(id);
        resolve();
      },
      { once: true },
    );
  });
}

interface QueuedScanJob {
  id: number;
  run: () => Promise<void>;
  cancelled: boolean;
  settled: () => void;
}

interface LocalGridContext {
  selectMode: boolean;
  selectedIds: Set<string>;
  handleToggleSelectId: (id: string) => void;
  handleToggleSelectGroup: (ids: string[]) => void;
  handlePlayEntry: (entry: LocalEntry, seriesGroup?: { key: string; head: LocalEntry }) => void;
  handleOpenDetail: (g: LocalGroup) => void;
  openIdentify: (target: LocalEntry[]) => void;
  refreshMetadata: (entries: LocalEntry[]) => void;
  markPosterFailed: (id: string) => void;
  clearPosterFailed: (id: string) => void;
  openEpisodes: (target: { key?: string; head: LocalEntry; episodes: LocalEntry[] }) => void;
  onAddToPlaylist: (target: AddToPlaylistTarget) => void;
}

type AddToPlaylistTarget =
  | { kind: 'movie'; entry: LocalEntry }
  | { kind: 'show'; key: string; head: LocalEntry; episodes: LocalEntry[] };


// Stable item renderer for the virtualized grid (defined outside render so
// Virtuoso only mounts items that are actually on screen — at 50k+ entries the
// DOM stays tiny and tab switches stay instant).
const LocalGridItem = (
  _index: number,
  g: LocalGroup,
  context?: LocalGridContext,
) => {
  if (!g || !context) return null;
  if (g.kind === 'movie') {
    return (
      <LocalMovieCard
        entry={g.entry}
        selectMode={context.selectMode}
        isSelected={context.selectedIds.has(g.entry.id)}
        onToggleSelect={context.handleToggleSelectId}
        onPlay={context.handlePlayEntry}
        onOpenDetail={() => context.handleOpenDetail(g)}
        onFixMatch={(entry) => context.openIdentify([entry])}
        onRefreshMetadata={(entry) => context.refreshMetadata([entry])}
        onPosterError={() => context.markPosterFailed(g.entry.id)}
        onPosterLoad={() => context.clearPosterFailed(g.entry.id)}
        onAddToPlaylist={(entry) => context.onAddToPlaylist({ kind: 'movie', entry })}
      />
    );
  }
  return (
    <LocalShowGroupCard
      head={g.head}
      episodes={g.episodes}
      seriesKey={g.key}
      selectMode={context.selectMode}
      isSelected={g.episodes.every((e) => context.selectedIds.has(e.id))}
      onToggleSelect={context.handleToggleSelectGroup}
      onOpenEpisodes={(head, episodes) => context.openEpisodes({ key: g.key, head, episodes })}
      onOpenDetail={() => context.handleOpenDetail(g)}
      onFixMatch={(episodes) => context.openIdentify(episodes)}
      onRefreshMetadata={(episodes) => context.refreshMetadata(episodes)}
      onPosterError={() => context.markPosterFailed(g.head.id)}
      onPosterLoad={() => context.clearPosterFailed(g.head.id)}
      onAddToPlaylist={(head, episodes) => context.onAddToPlaylist({ kind: 'show', key: g.key, head, episodes })}
    />
  );
};

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
  const favorites = useVodFavoritesStore((s) => s.favorites);

  const [activeFilter, setActiveFilter] = useState<'all' | 'movies' | 'series' | 'favorites' | 'unmatched'>(
    initialFilter,
  );
  const [internalSearchQuery, setInternalSearchQuery] = useState('');
  const searchQuery = searchQueryProp !== undefined ? searchQueryProp : internalSearchQuery;
  const handleSearchChange = useCallback((query: string) => {
    setInternalSearchQuery(query);
    onSearchChange?.(query);
  }, [onSearchChange]);
  const [sortKey, setSortKey] = useState<LocalSortKey>(() => {
    try {
      const saved = localStorage.getItem('localSortKey');
      return saved === 'name' || saved === 'rating' || saved === 'year' || saved === 'added' ? saved : 'added';
    } catch {
      return 'added';
    }
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    try {
      const saved = localStorage.getItem('localSortDir');
      return saved === 'asc' || saved === 'desc' ? saved : 'desc';
    } catch {
      return 'desc';
    }
  });
  const virtuosoRef = useRef<VirtualGridHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Effective filter (locked to a tab when opened from elsewhere) — drives
  // which items/banner/buttons are shown: Movies tab shows only Movies, Series
  // tab only Series.
  const effFilter = activeFilter === 'unmatched' ? 'unmatched' : lockFilter ? initialFilter : activeFilter;

  // Identity of the local list being browsed (see useScrollMemory). The active
  // filter is part of it, so each filter pill keeps its own position instead of
  // sharing one.
  const listKey = useMemo(
    () => `local:${effFilter}:${searchQuery ?? ''}:${sortKey}:${sortDir}`,
    [effFilter, searchQuery, sortKey, sortDir]
  );
  const [visibleRange, setVisibleRange] = useState({ startIndex: 0, endIndex: 0 });
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

  const handleSortChange = useCallback((key: LocalSortKey, dir: SortDir) => {
    setSortKey(key);
    setSortDir(dir);
    try {
      localStorage.setItem('localSortKey', key);
      localStorage.setItem('localSortDir', dir);
    } catch {
      /* ignore */
    }
  }, []);

  // Fixed item geometry for the virtualized grid: poster (aspect 2/3) + gap +
  // title + subtitle line. Virtuoso needs this to size rows and total height.
  const itemHeight = useMemo(() => Math.round(posterSize * 1.5) + 44, [posterSize]);

  // Scan state
  const [scanning, setScanning] = useState(false);
  const [walking, setWalking] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number } | null>(null);
  const [rateEta, setRateEta] = useState<{ rate: number; eta: number } | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [interruptedScan, setInterruptedScan] = useState<{ folderPath: string; current: number; total: number } | null>(null);
  const [rescanningMissing, setRescanningMissing] = useState(false);
  // Entry ids whose poster <img> failed to load this session (matched titles
  // with a broken/stale TMDB poster URL). These feed the "No Metadata" filter
  // so broken posters are discoverable even though the URL is truthy.
  const [posterFailures, setPosterFailures] = useState<Set<string>>(() => new Set());
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const scanAbortRef = useRef<AbortController | null>(null);
  // Serial scan queue: TMDB-heavy scans run one at a time so a second folder
  // added mid-scan waits instead of fighting the shared rate limit. Jobs can
  // be cancelled while still waiting (before they start).
  const scanQueueRef = useRef<QueuedScanJob[]>([]);
  const queueRunningRef = useRef(false);
  const nextScanJobIdRef = useRef(1);
  // Live rate/ETA bookkeeping (refs so the 500ms overlay tick can read them).
  const scanStartRef = useRef(0);
  const sessionDoneRef = useRef(0);
  const baseDoneRef = useRef(0);
  const totalRef = useRef(0);
  const [pendingScanFiles, setPendingScanFiles] = useState<ScannedFile[] | null>(null);
  const [pendingNfoCount, setPendingNfoCount] = useState<number>(0);
  const [pendingFolderPath, setPendingFolderPath] = useState<string | null>(null);
  const [pendingFolderType, setPendingFolderType] = useState<FolderType | undefined>(undefined);
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [foldersModalOpen, setFoldersModalOpen] = useState(false);

  // Modals / Details state
  const [identifyTarget, setIdentifyTarget] = useState<LocalEntry[] | null>(null);
  const [reviewTargets, setReviewTargets] = useState<LocalGroup[] | null>(null);
  // Queue of entry-lists to identify one after another (used when the user
  // picks several review groups to match at once).
  const identifyQueueRef = useRef<LocalEntry[][] | null>(null);
  // True between a successful identify resolve and its following onClose, so
  // the close handler knows not to wipe the next queued target.
  const resolvingRef = useRef(false);
  const [episodesModalTarget, setEpisodesModalTarget] = useState<{ key?: string; head: LocalEntry; episodes: LocalEntry[] } | null>(null);
  const [selectedDetailGroup, setSelectedDetailGroup] = useState<LocalGroup | null>(null);
  const [addToPlaylistTarget, setAddToPlaylistTarget] = useState<AddToPlaylistTarget | null>(null);
  const [fileNotFoundTarget, setFileNotFoundTarget] = useState<LocalEntry | null>(null);
  const [hideUnavailable, setHideUnavailable] = useState<boolean>(
    () => localStorage.getItem('ynotv.local.hide_unavailable') === 'true',
  );
  const [cleanModalOpen, setCleanModalOpen] = useState(false);
  const scannedFolders = useScannedFolders();
  const foldersToRescan = useMemo(() => {
    const filter = effFilter === 'movies' ? 'movie' : effFilter === 'series' ? 'show' : undefined;
    if (!filter) return scannedFolders;
    const matching = scannedFolders.filter((f) => f.type === filter || f.type === 'mixed');
    return matching.length > 0 ? matching : scannedFolders;
  }, [scannedFolders, effFilter]);
  const [rescanningAll, setRescanningAll] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  }, []);

  // Undo toast: appears after a user-initiated edit/removal and lets them
  // revert it. Auto-dismisses; background changes (auto-sync, rescan, imports)
  // never trigger it.
  const [undoVisible, setUndoVisible] = useState(false);
  const undoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleUndoChange = useCallback(() => {
    setUndoVisible(true);
    if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
    undoHideTimerRef.current = setTimeout(() => setUndoVisible(false), 5000);
  }, []);
  useEffect(() => {
    const off = onUndoChange(handleUndoChange);
    return () => {
      off();
      if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
    };
  }, [handleUndoChange]);

  const handleUndo = useCallback(() => {
    undoLocalChange();
    setUndoVisible(false);
  }, []);

  // Background folder sync on mount / interval
  useAutoLocalSync(
    tmdbToken,
    useCallback(
      (res: { added: number; removed: number; unavailable?: number; restored?: number }) => {
        // showToast replaces the current message, so combine all sync results
        // into one toast instead of calling it repeatedly (later calls would
        // overwrite earlier ones in the same tick).
        const parts: string[] = [];
        if (res.added > 0) {
          parts.push(t('addedNewItems', { count: res.added }));
        }
        if ((res.unavailable ?? 0) > 0) {
          parts.push(t('unavailableFoundToast', '{{count}} items unavailable (files or drive missing)', { count: res.unavailable }));
        }
        if ((res.restored ?? 0) > 0) {
          parts.push(t('restoredItemsToast', '{{count}} items restored', { count: res.restored }));
        }
        if (parts.length > 0) {
          showToast(parts.join(' · '));
        }
      },
      [showToast, t],
    ),
  );

  // Offer to resume a scan that was interrupted by an app restart. Progress is
  // persisted to SQLite (scan-state.ts); entries already scanned are in the
  // library (persisted incrementally), so a resume only processes the rest.
  useEffect(() => {
    void (async () => {
      try {
        await ensureLocalLibraryLoaded();
        const state = await loadScanState();
        if (!state || !state.folderPath) return;
        if (state.status === 'completed') {
          clearScanState();
          return;
        }
        const folders = readScannedFolders();
        const stillTracked = folders.some(
          (f) => f.path.replace(/\\/g, '/').toLowerCase() === state.folderPath.replace(/\\/g, '/').toLowerCase(),
        );
        if (!stillTracked) {
          clearScanState();
          return;
        }
        setInterruptedScan({ folderPath: state.folderPath, current: state.current, total: state.total });
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // Group items into movies & series
  const groups = useMemo(() => groupLocal(items), [items]);

  // Counts
  const movieCount = useMemo(() => groups.filter((g) => g.kind === 'movie').length, [groups]);
  const seriesCount = useMemo(() => groups.filter((g) => g.kind === 'show').length, [groups]);
  // A group is "favorited" when its local media id (`local_<path>` for movies,
  // `local_<show key>` for series) exists in the VOD favorites store.
  const isGroupFavorited = useCallback(
    (g: LocalGroup) =>
      g.kind === 'movie'
        ? favorites.some((f) => f.id === `local_${g.entry.id}` && f.type === 'movie')
        : favorites.some((f) => f.id === `local_${g.key}` && f.type === 'series'),
    [favorites],
  );
  const favoriteCount = useMemo(() => groups.filter(isGroupFavorited).length, [groups, isGroupFavorited]);
  // A group counts as "missing metadata" when it has no match identity (no
  // TMDB/IMDB id) or its poster/art never loaded — the cards show the poster
  // fallback for these. Used by the "No Metadata" filter so a full-drive scan
  // can be spot-checked in one click.
  const markPosterFailed = useCallback((id: string) => {
    setPosterFailures((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const clearPosterFailed = useCallback((id: string) => {
    setPosterFailures((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const groupMissingMetadata = useCallback(
    (g: LocalGroup): boolean => {
      const e = g.kind === 'movie' ? g.entry : g.head;
      const ids = g.kind === 'movie' ? [g.entry.id] : g.episodes.map((ep) => ep.id);
      return (
        (!e.tmdbId && !e.imdbId) ||
        !(e.poster || e.localArt?.poster) ||
        ids.some((id) => posterFailures.has(id))
      );
    },
    [posterFailures],
  );
  const unmatchedCount = useMemo(() => {
    return groups.filter((g) => {
      if (effFilter === 'movies' && g.kind !== 'movie') return false;
      if (effFilter === 'series' && g.kind !== 'show') return false;
      return groupMissingMetadata(g);
    }).length;
  }, [groups, effFilter, groupMissingMetadata]);

  const unavailableGroupsCount = useMemo(() => {
    return groups.filter((g) => {
      if (effFilter === 'movies' && g.kind !== 'movie') return false;
      if (effFilter === 'series' && g.kind !== 'show') return false;
      return g.kind === 'movie' ? !!g.entry.unavailable : g.episodes.length > 0 && g.episodes.every((e) => e.unavailable);
    }).length;
  }, [groups, effFilter]);

  const handleCleanUnavailable = useCallback(() => {
    setCleanModalOpen(true);
  }, []);

  // Review is per SERIES FOLDER, never per file: a show group is one review
  // unit (all its episodes share the same folder-derived title and one TMDB
  // lookup), so a 500-episode unmatched folder counts as a single item.
  // Items the user chose to skip are excluded and never re-added to the queue.
  // Scoped to the current tab (Movies vs Series).
  const reviewGroups = useMemo(() => {
    return groups.filter((g) => {
      if (effFilter === 'movies' && g.kind !== 'movie') return false;
      if (effFilter === 'series' && g.kind !== 'show') return false;
      if (g.kind === 'movie') {
        return (
          !g.entry.reviewSkipped &&
          !!(g.entry.needsReview || (!g.entry.tmdbId && !g.entry.imdbId))
        );
      }
      return g.episodes.some(
        (e) => !e.reviewSkipped && (e.needsReview || (!e.tmdbId && !e.imdbId)),
      );
    });
  }, [groups, effFilter]);

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
    let list = groups;

    if (hideUnavailable) {
      list = list.filter((g) =>
        g.kind === 'movie' ? !g.entry.unavailable : !g.episodes.every((e) => e.unavailable),
      );
    }

    if (effFilter === 'movies') {
      list = list.filter((g) => g.kind === 'movie');
    } else if (effFilter === 'series') {
      list = list.filter((g) => g.kind === 'show');
    } else if (effFilter === 'favorites') {
      list = list.filter(isGroupFavorited);
    } else if (effFilter === 'unmatched') {
      list = list.filter((g) => {
        if (lockFilter && initialFilter === 'movies' && g.kind !== 'movie') return false;
        if (lockFilter && initialFilter === 'series' && g.kind !== 'show') return false;
        return groupMissingMetadata(g);
      });
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((g) => {
        const title = (g.kind === 'movie' ? g.entry.title : g.head.title) || '';
        return title.toLowerCase().includes(q);
      });
    }

    return sortGroups(list, sortKey, sortDir);
  }, [groups, lockFilter, initialFilter, activeFilter, searchQuery, sortKey, sortDir, isGroupFavorited, groupMissingMetadata, hideUnavailable]);

  // Once the items for the current view are rendered, jump back to the
  // remembered offset so returning users land exactly where they left off (the
  // restore is re-applied while the grid is still growing — rows are re-measured
  // and posters load async, so a single application can land short).
  const { onScroll: handleGridScroll } = useScrollMemory({
    listKey,
    scrollRef,
    ready: filteredGroups.length > 0,
    onNoSavedPosition: () => {
      // New view (fresh search/sort/filter with no saved offset) — start at the
      // top instead of inheriting the previous view's scroll position.
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    },
  });

  // Alphabet #-Z quick jump rail (only meaningful in name order).
  const groupNames = useMemo(
    () => filteredGroups.map((g) => ({ name: (g.kind === 'movie' ? g.entry.title : g.head.title) || '' })),
    [filteredGroups],
  );
  const alphabetIndex = useAlphabetIndex(groupNames);
  const availableLetters = useMemo(() => new Set(alphabetIndex.keys()), [alphabetIndex]);
  const currentLetter = useCurrentLetter(groupNames, visibleRange.startIndex);
  const handleLetterSelect = useCallback(
    (letter: string) => {
      const index = alphabetIndex.get(letter);
      if (index !== undefined && virtuosoRef.current) {
        virtuosoRef.current.scrollToIndex({ index, align: 'start' });
      }
    },
    [alphabetIndex],
  );

  // Play handler
  const handlePlayEntry = useCallback(
    async (entry: LocalEntry, seriesGroup?: { key: string; head: LocalEntry }) => {
      if (entry.unavailable) {
        setFileNotFoundTarget(entry);
        return;
      }
      const exists = await invoke<boolean>('check_path_exists', { path: entry.path }).catch(() => true);
      if (!exists) {
        markEntriesAvailability([entry.id], []);
        setFileNotFoundTarget(entry);
        return;
      }

      const playInfo = localEntryToVodPlayInfo(entry, seriesGroup);
      if (onPlayVod) {
        onPlayVod(playInfo);
      } else {
        // Dispatch global playback event
        window.dispatchEvent(new CustomEvent('ynotv:stremio-play', { detail: playInfo }));
      }
    },
    [onPlayVod],
  );

  // Detail handler: cross-link matched items to an external detail view when provided
  const handleOpenDetail = useCallback((group: LocalGroup) => {
    const entry = group.kind === 'movie' ? group.entry : group.head;
    if (onOpenDetail && (entry.tmdbId != null || entry.imdbId != null)) {
      onOpenDetail(entry);
    } else {
      setSelectedDetailGroup(group);
    }
  }, [onOpenDetail]);

  // Folder picking & scan initiation. `type` says whether the folder holds
  // movies or structured series folders; it drives both the scan strategy and
  // how the folder is stored.
  const handleAddFolder = useCallback(async (type: FolderType = 'mixed') => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dialogTitle =
        type === 'show'
          ? t('selectSeriesFolderDialogTitle', 'Select a folder of Series (each series in its own subfolder)')
          : type === 'movie'
            ? t('selectMovieFolderDialogTitle', 'Select a folder of Movies')
            : t('selectFolderDialogTitle', 'Select Folder with Movies or Shows');
      const selected = await open({
        directory: true,
        multiple: false,
        title: dialogTitle,
      });
      if (!selected || typeof selected !== 'string') return;

      setWalking(true);
      clearSidecarCache();
      await ensureLocalLibraryLoaded();
      const files = await invoke<ScannedFile[]>('scan_local_folder', { folder: selected });

      if (!files || files.length === 0) {
        setWalking(false);
        showToast(t('noVideoFilesFound'));
        return;
      }

      addScannedFolder(selected, type);
      setPendingFolderPath(selected);
      setPendingFolderType(type);

      const nfos = await countNfoFor(files.map((f) => f.path));
      if (nfos > 0) {
        setPendingScanFiles(files);
        setPendingNfoCount(nfos);
        setScanModalOpen(true);
        setWalking(false);
      } else {
        await executeScan(files, 'tmdb', { folderPath: selected, folderType: type });
        // Clear the "walking" flag once the scan finishes so the Add buttons
        // stop showing "Scanning...".
        setWalking(false);
      }
    } catch (err: any) {
      console.error('[LocalTab] Folder scan failed:', err);
      setWalking(false);
      showToast(err?.message || t('folderScanFailed'));
    }
  }, [showToast, t]);

  const handleRescanSpecificFolder = useCallback(async (folderPath: string) => {
    try {
      clearSidecarCache();
      await ensureLocalLibraryLoaded();
      const folder = findScannedFolder(folderPath);
      const folderType = folder?.type ?? 'mixed';
      const files = await invoke<ScannedFile[]>('scan_local_folder', { folder: folderPath });
      if (!files || files.length === 0) {
        showToast(t('noVideoFilesFound'));
        return;
      }
      addScannedFolder(folderPath, folderType);
      await executeScan(files, 'tmdb', { folderPath, folderType });
    } catch (err: any) {
      console.error('[LocalTab] Rescan failed:', err);
      showToast(err?.message || t('rescanFailed'));
    }
  }, [showToast, t]);

  // TMDB lookups are global rate-limited (~40 req/s, services/tmdbRateLimit.ts),
  // so scanning with a small worker pool saturates the limit without tripping
  // 429s — far faster than the old one-at-a-time loop.
  const SCAN_CONCURRENCY = 12;

  // Serialize TMDB-heavy scans: folder scans and rescan-missing share one queue
  // so a second folder added mid-scan waits for the first instead of running
  // two concurrent scans that fight over the global TMDB rate limit. The drain
  // loop skips jobs that were cancelled while waiting.
  const drainQueue = useCallback(async () => {
    if (queueRunningRef.current) return;
    queueRunningRef.current = true;
    try {
      for (;;) {
        const head = scanQueueRef.current[0];
        if (!head) break;
        if (head.cancelled) {
          scanQueueRef.current.shift();
          setQueuedCount(scanQueueRef.current.length);
          continue;
        }
        setQueuedCount(scanQueueRef.current.length);
        try {
          await head.run();
        } catch {
          /* run() implementations handle their own errors */
        }
        head.settled();
        scanQueueRef.current.shift();
        setQueuedCount(scanQueueRef.current.length);
      }
    } finally {
      queueRunningRef.current = false;
    }
  }, []);

  const enqueueScan = useCallback((run: () => Promise<void>): Promise<void> => {
    return new Promise<void>((resolve) => {
      const job: QueuedScanJob = {
        id: nextScanJobIdRef.current++,
        run,
        cancelled: false,
        settled: resolve,
      };
      scanQueueRef.current.push(job);
      setQueuedCount(scanQueueRef.current.length);
      void drainQueue();
    });
  }, [drainQueue]);

  // Drop every scan still waiting in the queue (the one actively running keeps
  // its own Cancel button). Settles their promises so callers don't hang.
  const cancelQueuedScans = useCallback(() => {
    for (const job of scanQueueRef.current) {
      if (job.cancelled) continue;
      job.cancelled = true;
      job.settled();
    }
    setQueuedCount(scanQueueRef.current.filter((j) => !j.cancelled).length);
  }, []);

  // Live items/sec + ETA readout. Workers only bump the counters; a 500ms
  // interval recomputes the rate from elapsed time so the ETA keeps moving
  // even while individual lookups are slow (e.g. rate-limit backoff).
  useEffect(() => {
    if (!scanning && !rescanningMissing) return;
    const update = () => {
      const elapsed = (Date.now() - scanStartRef.current) / 1000;
      const done = sessionDoneRef.current;
      const rate = elapsed > 1 ? done / elapsed : 0;
      const remaining = Math.max(0, totalRef.current - (baseDoneRef.current + done));
      setRateEta(rate > 0 && remaining > 0 ? { rate, eta: remaining / rate } : null);
    };
    update();
    const id = setInterval(update, 500);
    return () => clearInterval(id);
  }, [scanning, rescanningMissing]);

  // When a scan / rescan finishes, warm the browser cache for the first few
  // rows of posters during idle time (small batches per requestIdleCallback
  // slice, low fetch priority) so the freshly-populated grid's initial fill
  // doesn't burst the image CDN. Only the currently-rendered, sorted order is
  // preloaded — that's exactly what the grid mounts first.
  const prevScanBusyRef = useRef(false);
  useEffect(() => {
    const busy = scanning || rescanningMissing;
    if (prevScanBusyRef.current && !busy && !walking && document.querySelector('.local-grid')) {
      const urls: string[] = [];
      for (const g of filteredGroups) {
        const e = g.kind === 'movie' ? g.entry : g.head;
        const poster = e.poster || e.localArt?.poster;
        if (poster) urls.push(poster);
      }
      preloadPosters(urls);
    }
    prevScanBusyRef.current = busy;
  }, [scanning, rescanningMissing, walking, filteredGroups]);
  // Cancel any trickling preload when the tab unmounts (a new scan completion
  // supersedes an old run anyway via the run id inside preloadPosters).
  useEffect(() => () => cancelPosterPreload(), []);

  const runScan = async (
    files: ScannedFile[],
    mode: ScanMode,
    folderPath: string | null,
    folderType?: FolderType,
    total = files.length,
    baseDone = 0,
  ) => {
    setScanning(true);
    setInterruptedScan(null);
    pausedRef.current = false;
    setPaused(false);
    await ensureLocalLibraryLoaded();
    totalRef.current = total;
    baseDoneRef.current = baseDone;
    sessionDoneRef.current = 0;
    scanStartRef.current = Date.now();
    setScanProgress({ current: baseDone, total });
    setRateEta(null);
    const controller = new AbortController();
    scanAbortRef.current = controller;
    const { signal } = controller;
    const parsed = files.map((f) => ({ file: f, info: parseFilename(f.filename) }));

    // Persist progress so a restart can resume this scan (entries completed so
    // far are already persisted row-by-row; only the counters were lost).
    let lastPersist = Date.now();
    const persistTick = (done: number) => {
      if (!folderPath) return;
      const now = Date.now();
      if (done % 100 === 0 || now - lastPersist > 2000) {
        lastPersist = now;
        writeScanState({ folderPath, current: baseDone + done, total, status: 'scanning', updatedAt: now });
      }
    };
    if (folderPath) {
      writeScanState({ folderPath, current: baseDone, total, status: 'scanning', updatedAt: Date.now() });
      // Per-file checkpoint: the full path list, persisted once. A resume uses
      // this to compute remaining files without re-walking the whole folder.
      writeScanFiles(files.map((f) => f.path));
    }

    const built: LocalEntry[] = new Array(parsed.length);
    let done = 0;
    let next = 0;
    const workers = Array.from(
      { length: Math.min(SCAN_CONCURRENCY, parsed.length) },
      async () => {
        for (;;) {
          if (signal.aborted) return;
          await waitWhilePaused(pausedRef, signal);
          if (signal.aborted) return;
          const idx = next++;
          if (idx >= parsed.length) return;
          const { file, info } = parsed[idx];
          const targetFolderPath = file.folderPath ?? folderPath;
          const targetFolderType = file.folderType ?? folderType;
          try {
            const entry =
              mode === 'nfo'
                ? await buildNfoEntryForFolder(file, targetFolderType, targetFolderPath, tmdbToken, signal)
                : await buildTmdbEntryForFolder(file, targetFolderType, targetFolderPath, tmdbToken, signal);
            if (signal.aborted) return;
            built[idx] = entry;
            // Crash-safe checkpoint: persist each completed entry to SQLite as
            // it finishes so a mid-scan restart only re-scans in-flight files.
            persistLocalEntryIncremental(entry);
          } catch (e: unknown) {
            // Aborting mid-scan: drop the in-flight file so only fully
            // scanned entries are kept.
            if (e instanceof DOMException && e.name === 'AbortError') return;
            built[idx] = {
              id: file.path,
              path: file.path,
              filename: file.filename,
              title: info.title,
              year: info.year,
              type: info.type,
              resolution: info.resolution,
              addedAt: Date.now(),
              needsReview: true,
            };
          }
          done += 1;
          sessionDoneRef.current = done;
          setScanProgress({ current: baseDone + done, total });
          persistTick(done);
        }
      },
    );
    await Promise.all(workers);
    if (scanAbortRef.current === controller) scanAbortRef.current = null;
    pausedRef.current = false;
    setPaused(false);

    // Keep whatever finished before the cancel — already-scanned entries stay.
    addLocalEntries(built.filter((e): e is LocalEntry => !!e));
    if (signal.aborted) {
      if (folderPath) {
        writeScanState({ folderPath, current: baseDone + done, total, status: 'cancelled', updatedAt: Date.now() });
        setInterruptedScan({ folderPath, current: baseDone + done, total });
      }
    } else {
      clearScanState();
      clearScanFiles();
    }
    setScanning(false);
    setScanProgress(null);
    setRateEta(null);
    setPendingScanFiles(null);
    setPendingFolderPath(null);
    setPendingFolderType(undefined);
    showToast(
      signal.aborted
        ? t('scanCancelled', 'Scan cancelled. Already scanned items were kept.')
        : t('addedItemsToLibrary', { count: built.length }),
    );
  };

  const executeScan = (
    files: ScannedFile[],
    mode: ScanMode,
    opts?: { folderPath?: string | null; folderType?: FolderType; total?: number; baseDone?: number },
  ): Promise<void> =>
    enqueueScan(() =>
      runScan(
        files,
        mode,
        opts?.folderPath ?? null,
        opts?.folderType,
        opts?.total ?? files.length,
        opts?.baseDone ?? 0,
      ),
    );

  const handleRescanAllFolders = useCallback(async () => {
    if (foldersToRescan.length === 0 || rescanningAll || scanning || walking) return;
    setRescanningAll(true);
    setWalking(true);
    try {
      clearSidecarCache();
      await ensureLocalLibraryLoaded();
      const allFiles: ScannedFile[] = [];
      for (const folder of foldersToRescan) {
        if (scanAbortRef.current?.signal.aborted) break;
        try {
          const exists = await invoke<boolean>('check_path_exists', { path: folder.path }).catch(() => true);
          if (!exists) {
            console.warn(`[LocalTab] Skipping offline folder: ${folder.path}`);
            continue;
          }
          const files = await invoke<ScannedFile[]>('scan_local_folder', { folder: folder.path });
          if (files && files.length > 0) {
            addScannedFolder(folder.path, folder.type);
            for (const f of files) {
              f.folderPath = folder.path;
              f.folderType = folder.type;
              allFiles.push(f);
            }
          }
        } catch (err) {
          console.error(`[LocalTab] Folder walk failed for ${folder.path}:`, err);
        }
      }
      setWalking(false);

      if (allFiles.length === 0) {
        showToast(t('noVideoFilesFound'));
        return;
      }

      await executeScan(
        allFiles,
        'tmdb',
        foldersToRescan.length === 1
          ? { folderPath: foldersToRescan[0].path, folderType: foldersToRescan[0].type }
          : undefined,
      );
    } catch (err: any) {
      console.error('[LocalTab] Rescan all failed:', err);
      setWalking(false);
      showToast(err?.message || t('rescanFailed'));
    } finally {
      setRescanningAll(false);
    }
  }, [foldersToRescan, rescanningAll, scanning, walking, executeScan, showToast, t]);

  // Re-run TMDB matching only for entries that are still ambiguous/unmatched,
  // without re-scanning the disk or re-touching already-matched titles.
  const runRescanMissing = async (missing: LocalEntry[]) => {
    setRescanningMissing(true);
    setInterruptedScan(null);
    pausedRef.current = false;
    setPaused(false);
    const total = missing.length;
    totalRef.current = total;
    baseDoneRef.current = 0;
    sessionDoneRef.current = 0;
    scanStartRef.current = Date.now();
    setScanProgress({ current: 0, total });
    setRateEta(null);
    const controller = new AbortController();
    scanAbortRef.current = controller;
    const { signal } = controller;

    const freshById = new Map<string, LocalEntry>();
    let done = 0;
    let next = 0;
    const workers = Array.from(
      { length: Math.min(SCAN_CONCURRENCY, missing.length) },
      async () => {
        for (;;) {
          if (signal.aborted) return;
          await waitWhilePaused(pausedRef, signal);
          if (signal.aborted) return;
          const idx = next++;
          if (idx >= missing.length) return;
          const e = missing[idx];
          try {
            const fresh = await refreshTmdbEntry(e, tmdbToken, signal);
            if (signal.aborted) return;
            freshById.set(e.id, { ...e, ...fresh, id: e.id, path: e.path, addedAt: e.addedAt });
          } catch (err: unknown) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            freshById.set(e.id, e);
          }
          done += 1;
          sessionDoneRef.current = done;
          setScanProgress({ current: done, total });
        }
      },
    );
    await Promise.all(workers);
    if (scanAbortRef.current === controller) scanAbortRef.current = null;
    pausedRef.current = false;
    setPaused(false);

    // Apply whatever completed before the cancel. noUndo: re-running TMDB
    // matching over many titles isn't a single reversible user edit.
    updateLocalEntries(Array.from(freshById.keys()), (entry) => freshById.get(entry.id) ?? {}, { noUndo: true });
    setRescanningMissing(false);
    setScanProgress(null);
    setRateEta(null);
    showToast(
      signal.aborted
        ? t('scanCancelled', 'Scan cancelled. Already scanned items were kept.')
        : t('rescannedMetadata', 'Rescanned metadata for {{count}} titles.', { count: freshById.size }),
    );
  };

  const handleCancelScan = useCallback(() => {
    scanAbortRef.current?.abort();
  }, []);

  // Pause / resume the active scan. Pausing only gates the worker loops (no
  // new TMDB requests); in-flight lookups finish first.
  const handleTogglePause = useCallback(() => {
    if (!scanAbortRef.current) return;
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  }, []);

  // Resume an interrupted/cancelled scan: use the persisted per-file checkpoint
  // when available (no folder re-walk), skip every file already in the library
  // (entries were persisted incrementally), and continue the progress counters
  // from where the previous run stopped. Falls back to re-walking the folder
  // only for legacy state that predates the checkpoint.
  const handleResumeScan = useCallback(async () => {
    const target = interruptedScan;
    if (!target) return;
    setInterruptedScan(null);
    try {
      clearSidecarCache();
      await ensureLocalLibraryLoaded();
      const existing = new Set(readLocalLibrary().map((e) => e.path.toLowerCase()));
      const persistedPaths = await loadScanFiles();

      let files: ScannedFile[] | null = null;
      let total = target.total;
      if (persistedPaths && persistedPaths.length > 0) {
        // Checkpoint from the interrupted run: no folder re-walk needed. The
        // filename is derivable from the path (parseFilename needs the basename).
        files = persistedPaths
          .filter((p) => !existing.has(p.toLowerCase()))
          .map((p) => ({ path: p, filename: p.split(/[\\/]/).pop() || p, size: 0 }));
      } else {
        const walked = await invoke<ScannedFile[]>('scan_local_folder', { folder: target.folderPath });
        if (Array.isArray(walked) && walked.length > 0) {
          files = walked.filter((f) => !existing.has(f.path.toLowerCase()));
          total = walked.length;
        }
      }

      if (!files || files.length === 0) {
        clearScanState();
        clearScanFiles();
        return;
      }
      const folderType = findScannedFolder(target.folderPath)?.type ?? 'mixed';
      addScannedFolder(target.folderPath, folderType);
      await executeScan(files, 'tmdb', {
        folderPath: target.folderPath,
        folderType,
        total,
        baseDone: total - files.length,
      });
    } catch (err: any) {
      console.error('[LocalTab] Resume scan failed:', err);
      showToast(err?.message || t('folderScanFailed'));
    }
  }, [interruptedScan, showToast, t]);

  const handleDismissInterrupted = useCallback(() => {
    clearScanState();
    setInterruptedScan(null);
  }, []);

  const handleScanModePick = (mode: ScanMode) => {
    setScanModalOpen(false);
    if (pendingScanFiles) {
      void executeScan(pendingScanFiles, mode, {
        folderPath: pendingFolderPath,
        folderType: pendingFolderType,
      });
    }
  };

  // Advance to the next queued review group after a resolve/skip/remove;
  // closes the modal when the queue is exhausted.
  const advanceIdentifyQueue = useCallback(() => {
    const q = identifyQueueRef.current;
    if (q && q.length > 0) {
      identifyQueueRef.current = q.slice(1);
      setIdentifyTarget(q[0]);
    } else {
      identifyQueueRef.current = null;
      setIdentifyTarget(null);
    }
  }, []);

  // Identify resolution
  const handleIdentifyResolved = useCallback((ids: string[], resolution: IdentifyResolution) => {
    resolvingRef.current = true;
    // A manual fix overrides whatever TMDB matched — drop the per-title match
    // cache so a later re-scan re-queries instead of resurrecting the old match.
    clearTmdbMatchCache();
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
        // A manual match also un-skips the item (the user decided to match it).
        reviewSkipped: false,
        // Manual match — freeze it so a re-scan can't overwrite it.
        metadataLocked: true,
      };
    });
    setSelectedIds(new Set());
    setSelectMode(false);
    showToast(
      ids.length > 1
        ? t('matchedFilesAs', { count: ids.length, title: resolution.title })
        : t('matchUpdated')
    );

    advanceIdentifyQueue();
  }, [showToast, t, advanceIdentifyQueue]);

  // Match one or more review groups: identify each series/movie one at a time.
  const openReviewMatch = useCallback((groups: LocalGroup[]) => {
    const lists = groups.map((g) => (g.kind === 'movie' ? [g.entry] : g.episodes));
    identifyQueueRef.current = lists.length > 1 ? lists.slice(1) : null;
    setIdentifyTarget(lists[0] ?? null);
  }, []);

  // Skip metadata matching for the given review group(s): the items stay in
  // the library with their parsed title but stop appearing in the review
  // queue and are never re-matched by scans.
  const handleReviewSkip = useCallback(
    (ids: string[]) => {
      updateLocalEntries(ids, { needsReview: false, reviewSkipped: true });
      showToast(t('reviewSkipToast', 'Skipped — will not be matched'));
    },
    [showToast, t],
  );

  // Skip/Remove from the Identify modal (the banner's "Review" flow): act on
  // the current review unit, then advance to the next queued group (or close).
  const handleIdentifySkip = useCallback(
    (ids: string[]) => {
      handleReviewSkip(ids);
      advanceIdentifyQueue();
    },
    [handleReviewSkip, advanceIdentifyQueue],
  );

  const handleIdentifyRemove = useCallback(
    (ids: string[]) => {
      removeLocalEntries(ids);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      showToast(t('removedSelectedItems', 'Removed selected items'));
      advanceIdentifyQueue();
    },
    [removeLocalEntries, showToast, t, advanceIdentifyQueue],
  );

  // Refresh Metadata: force a fresh TMDB lookup for the given entries (used
  // by the card button when metadata/posters didn't load). The per-title
  // match cache is invalidated first so a stale or broken result is re-fetched,
  // then matching re-runs through the same scan queue as rescan-missing.
  const handleRefreshMetadata = useCallback(
    (entries: LocalEntry[]) => {
      if (entries.length === 0) return;
      if (!tmdbToken) {
        showToast(
          t('rescanNeedsTmdb', 'Refreshing metadata requires a TMDB API key (Settings → TMDB).'),
        );
        return;
      }
      for (const e of entries) {
        if (e.tmdbId) {
          invalidateTmdbIdMatchCache(e.tmdbId, e.type);
        }
        const parsed = parseFilename(e.filename);
        invalidateTmdbMatchCache(parsed.title, parsed.year, parsed.type);
      }
      // Drop any recorded poster failures — the refreshed entries get a fresh
      // poster URL, and onLoad/onError will re-report the truth.
      setPosterFailures((prev) => {
        const next = new Set(prev);
        for (const e of entries) next.delete(e.id);
        return next;
      });
      void enqueueScan(() => runRescanMissing(entries));
    },
    [tmdbToken, enqueueScan, showToast, t],
  );

  // Toolbar "Refresh Metadata": refreshes TMDB media for all linked items in the current section
  // (or all if browsing all), bypassing cached lookups and fetching directly by linked tmdbId.
  const handleRefreshAllMetadata = useCallback(() => {
    const linked = items.filter(
      (e) =>
        (effFilter === 'movies' ? e.type === 'movie' : effFilter === 'series' ? e.type === 'show' : true) &&
        e.tmdbId != null,
    );
    if (linked.length === 0) {
      showToast(t('noLinkedMetadata', 'No matched titles to refresh.'));
      return;
    }
    handleRefreshMetadata(linked);
  }, [items, effFilter, handleRefreshMetadata, showToast, t]);

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

  // Memoized context for the virtualized grid — only the visible items
  // re-render when this changes (selection, handlers), not the whole list.
  const handleAddToPlaylist = useCallback((target: AddToPlaylistTarget) => {
    setAddToPlaylistTarget(target);
  }, []);

  const gridContext = useMemo<LocalGridContext>(
    () => ({
      selectMode,
      selectedIds,
      handleToggleSelectId,
      handleToggleSelectGroup,
      handlePlayEntry,
      handleOpenDetail,
      openIdentify: setIdentifyTarget,
      refreshMetadata: handleRefreshMetadata,
      markPosterFailed,
      clearPosterFailed,
      openEpisodes: setEpisodesModalTarget,
      onAddToPlaylist: handleAddToPlaylist,
    }),
    [selectMode, selectedIds, handleToggleSelectId, handleToggleSelectGroup, handlePlayEntry, handleOpenDetail, handleRefreshMetadata, markPosterFailed, clearPosterFailed, handleAddToPlaylist],
  );

  // Convert a LocalTab target into the props AddToPlaylistModal expects, so
  // local movies/series use the exact same playlist flow as provider VOD.
  const addToPlaylistModalProps = useMemo(() => {
    if (!addToPlaylistTarget) return null;
    if (addToPlaylistTarget.kind === 'movie') {
      const movie = localEntryToStoredMovie(addToPlaylistTarget.entry);
      return {
        movie,
        series: null as StoredSeries | null,
        seasons: {} as Record<number, StoredEpisode[]>,
        // stream_icon is a converted asset URL (local file paths need
        // convertFileSrc to render as <img>), so use it for the poster.
        posterUrl: movie.stream_icon || null,
      };
    }
    const { key, head, episodes } = addToPlaylistTarget;
    const series = localGroupToStoredSeries({ key, head, episodes });
    const seasons: Record<number, StoredEpisode[]> = {};
    for (const ep of episodes) {
      const s = ep.season ?? 1;
      (seasons[s] ??= []).push(localEntryToStoredEpisode(ep, series.series_id, head.title));
    }
    return {
      movie: null as StoredMovie | null,
      series,
      seasons,
      posterUrl: series.cover || null,
    };
  }, [addToPlaylistTarget]);

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
              <button
                type="button"
                className={`local-type-pill ${activeFilter === 'favorites' ? 'active' : ''}`}
                onClick={() => setActiveFilter('favorites')}
                title={t('favoritesFilterTitle', 'Show only favorited local titles')}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill={activeFilter === 'favorites' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t('favorites', 'Favorites')}
                <span className="local-type-pill__count">{favoriteCount}</span>
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
          {/* Missing metadata toggle — one click shows only titles whose
              metadata/posters never loaded (count updates live). */}
          <button
            type="button"
            className={`local-type-pill ${activeFilter === 'unmatched' ? 'active' : ''}`}
            onClick={() => setActiveFilter((prev) => (prev === 'unmatched' ? 'all' : 'unmatched'))}
            title={t('unmatchedFilterTitle', 'Show only titles whose metadata or posters never loaded — fix them with the Refresh Metadata / Refresh All buttons')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {t('noMetadata', 'No Metadata')}
            <span className="local-type-pill__count">{unmatchedCount}</span>
          </button>

          {/* Unavailable toggle */}
          {unavailableGroupsCount > 0 && (
            <button
              type="button"
              className={`local-type-pill ${hideUnavailable ? 'active' : ''}`}
              onClick={() => {
                const next = !hideUnavailable;
                setHideUnavailable(next);
                localStorage.setItem('ynotv.local.hide_unavailable', String(next));
              }}
              title={hideUnavailable ? t('showUnavailableTooltip', 'Unavailable files are hidden — click to show') : t('hideUnavailableTooltip', 'Click to hide unavailable files')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {hideUnavailable ? t('unavailableHidden', 'Unavailable Hidden') : t('unavailableShowing', 'Unavailable')}
              <span className="local-type-pill__count">{unavailableGroupsCount}</span>
            </button>
          )}

          {/* Sort Dropdown */}
          <select
            className="local-select-dropdown"
            value={`${sortKey}_${sortDir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split('_') as [LocalSortKey, SortDir];
              handleSortChange(key, dir);
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

          {/* Rescan All Folders Button */}
          {foldersToRescan.length > 0 && (
            <button
              type="button"
              className="local-btn local-btn--secondary"
              onClick={() => void handleRescanAllFolders()}
              disabled={rescanningAll || scanning || walking}
              title={t('rescanAllTitle', 'Scan all configured folders for new media files')}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className={rescanningAll || scanning ? 'local-spin' : ''}
              >
                <path d="M23 4v6h-6M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              {rescanningAll || scanning ? t('scanning', 'Scanning...') : t('rescanAll', 'Rescan All')}
            </button>
          )}

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
              {selectMode ? t('common:done', 'Done') : t('select', 'Select')}
            </button>
          )}

          {/* Refresh Metadata Button */}
          {items.length > 0 && (
            <button
              type="button"
              className="local-btn local-btn--secondary"
              onClick={() => void handleRefreshAllMetadata()}
              disabled={rescanningMissing || scanning}
              title={t('refreshMetadataAllTitle', 'Re-fetch TMDB metadata and artwork for all matched titles')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M23 4v6h-6M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              {rescanningMissing ? t('scanning', 'Scanning...') : t('refreshMetadata', 'Refresh Metadata')}
            </button>
          )}

          {/* Add Folder Buttons — only the type matching the active tab */}
          <div className="local-add-folder-group">
            {effFilter !== 'series' && (
              <button
                type="button"
                className="local-btn local-btn--primary"
                onClick={() => void handleAddFolder('movie')}
                disabled={walking}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  <line x1="12" y1="11" x2="12" y2="17" />
                  <line x1="9" y1="14" x2="15" y2="14" />
                </svg>
                {scanning || walking ? t('scanning', 'Scanning...') : t('addMovies', 'Add Movies')}
              </button>
            )}
            {effFilter !== 'movies' && (
              <button
                type="button"
                className="local-btn local-btn--primary"
                onClick={() => void handleAddFolder('show')}
                disabled={walking}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  <line x1="12" y1="11" x2="12" y2="17" />
                  <line x1="9" y1="14" x2="15" y2="14" />
                </svg>
                {scanning || walking ? t('scanning', 'Scanning...') : t('addSeries', 'Add Series')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Needs Review Alert Banner — one unit per unmatched series/movie */}
      {reviewGroups.length > 0 && !selectMode && (
        <div className="local-review-banner">
          <div
            className="local-review-banner__left"
            onClick={() => {
              // Queue the whole review list: after matching one title the next
              // one pops up instead of the modal closing.
              openReviewMatch(reviewGroups);
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="local-review-banner__text">
              {t('needsReviewBanner', '{{count}} titles need review — help us identify them.', {
                count: reviewGroups.length,
              })}
            </span>
          </div>

          <div className="local-review-banner__actions">
            {reviewGroups.length > 1 && (
              <button
                type="button"
                className="local-review-banner__btn local-review-banner__btn--batch"
                onClick={(e) => {
                  e.stopPropagation();
                  // Open the review list (grouped per series folder) so the
                  // user can pick which unmatched series to match or remove.
                  setReviewTargets(reviewGroups);
                }}
                title={t('batchReviewAll', 'Review and manage unmatched items')}
              >
                {t('batchReview', 'Review Unmatched')}
              </button>
            )}
            <button
              type="button"
              className="local-review-banner__btn"
              onClick={(e) => {
                e.stopPropagation();
                openReviewMatch(reviewGroups);
              }}
            >
              {t('review', 'Review')}
            </button>
          </div>
        </div>
      )}

      {/* Unavailable Items Alert Banner */}
      {unavailableGroupsCount > 0 && !selectMode && (
        <div className="local-unavailable-banner">
          <div className="local-unavailable-banner__left">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="local-unavailable-banner__text">
              {t('unavailableBannerText', '{{count}} items are unavailable because their files or storage drives are not accessible.', {
                count: unavailableGroupsCount,
              })}
            </span>
          </div>

          <div className="local-unavailable-banner__actions">
            <button
              type="button"
              className="local-unavailable-banner__btn"
              onClick={() => {
                const next = !hideUnavailable;
                setHideUnavailable(next);
                localStorage.setItem('ynotv.local.hide_unavailable', String(next));
              }}
            >
              {hideUnavailable ? t('showItems', 'Show Items') : t('hideItems', 'Hide Items')}
            </button>
            <button
              type="button"
              className="local-unavailable-banner__btn local-unavailable-banner__btn--clean"
              onClick={handleCleanUnavailable}
              title={t('cleanUnavailableTitle', 'Remove permanently missing items from library')}
            >
              {t('cleanUnavailable', 'Clean Up')}
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
              {t('common:remove', 'Remove')}
            </button>
            <button
              type="button"
              className="local-btn local-btn--secondary"
              onClick={() => {
                setSelectMode(false);
                setSelectedIds(new Set());
              }}
            >
              {t('common:done', 'Done')}
            </button>
          </div>
        </div>
      )}

      {/* Interrupted-scan resume banner */}
      {interruptedScan && (
        <div className="local-resume-banner">
          <span className="local-resume-banner__text">
            {t('scanInterruptedBanner', 'Scan interrupted — {{current}} of {{total}} items scanned.', {
              current: interruptedScan.current,
              total: interruptedScan.total,
            })}
          </span>
          <div className="local-resume-banner__actions">
            <button type="button" className="local-btn local-btn--primary" onClick={() => void handleResumeScan()}>
              {t('resumeScan', 'Resume scan')}
            </button>
            <button type="button" className="local-btn local-btn--secondary" onClick={handleDismissInterrupted}>
              {t('dismissScan', 'Dismiss')}
            </button>
          </div>
        </div>
      )}

      {/* Folder walk in progress — no counts yet because the file list hasn't
          been enumerated (the walk is the fast part, matching follows). */}
      {walking && (
        <div className="local-scan-progress">
          <div style={{ flex: 1 }}>
            <div className="local-scan-progress__row">
              <span className="local-scan-waiting__spinner" style={{ marginRight: '8px' }} />
              <span>{t('walkingFolder', 'Scanning folder for media files…')}</span>
            </div>
          </div>
        </div>
      )}

      {/* Scan Progress Alert (folder scan or rescan-missing). The folder-scan
          bar counts each file as it is enriched, so this IS the metadata-
          matching progress (the walk above is the only phase without counts). */}
      {(scanning || rescanningMissing) && scanProgress && (
        <div className="local-scan-progress">
          <div style={{ flex: 1 }}>
            <div className="local-scan-progress__row">
              <span>
                {paused
                  ? t('scanPaused', 'Scan paused')
                  : rescanningMissing
                    ? t('rescanningMetadataFiles', 'Refreshing metadata...')
                    : t('scanningAndMatching', 'Scanning & matching metadata…')}
              </span>
              <span className="local-scan-progress__stats">
                {scanProgress.current} / {scanProgress.total}
                {!paused && rateEta && (
                  <span className="local-scan-progress__eta">
                    {t('scanEtaRate', '{{rate}} items/s · {{eta}} left', {
                      rate: rateEta.rate.toFixed(1),
                      eta: formatEta(rateEta.eta),
                    })}
                  </span>
                )}
                {queuedCount > 0 && (
                  <span className="local-scan-progress__queued">
                    {t('scanQueuedCount', '{{count}} queued', { count: queuedCount })}
                  </span>
                )}
              </span>
            </div>
            <div style={{ height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(scanProgress.current / scanProgress.total) * 100}%`, background: 'var(--accent-primary, #00d4ff)', transition: 'width 0.2s' }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            <button
              type="button"
              className="local-btn"
              onClick={handleTogglePause}
              disabled={!scanAbortRef.current}
              style={{ height: '32px', padding: '0 14px', fontSize: '12.5px' }}
            >
              {paused ? t('resumeScan', 'Resume scan') : t('pauseScan', 'Pause')}
            </button>
            <button
              type="button"
              className="local-btn"
              onClick={handleCancelScan}
              disabled={!scanAbortRef.current}
              style={{ height: '32px', padding: '0 14px', fontSize: '12.5px' }}
            >
              {t('stopScan', 'Stop')}
            </button>
          </div>
        </div>
      )}

      {/* Waiting for a queued scan (added a folder while another scan runs) */}
      {queuedCount > 0 && !scanning && !rescanningMissing && (
        <div className="local-scan-waiting">
          <span className="local-scan-waiting__spinner" />
          <span>
            {t('scanWaiting', 'Waiting for the current scan to finish… ({{count}} queued)', { count: queuedCount })}
          </span>
          <button
            type="button"
            className="local-btn local-scan-waiting__cancel"
            onClick={cancelQueuedScans}
            style={{ flexShrink: 0, height: '32px', padding: '0 14px', fontSize: '12.5px' }}
          >
            {t('cancelQueuedScans', 'Cancel queued scans')}
          </button>
        </div>
      )}

      {/* Main Content: Grid or Empty State */}
      {effFilter === 'unmatched' && unmatchedCount === 0 && !scanning && !walking ? (
        <div className="local-empty-state">
          <div className="local-empty-state__icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h3 className="local-empty-state__title">
            {t('noMissingMetadataTitle', 'Nothing is missing')}
          </h3>
          <p className="local-empty-state__desc">
            {t('noMissingMetadataDesc', 'Every title has metadata and a poster. If a title ever fails to load its poster, it will show up here — just click Refresh All in the toolbar to re-match it.')}
          </p>
          <div className="local-empty-state__actions">
            <button
              type="button"
              className="local-btn local-btn--secondary"
              style={{ padding: '0 24px', height: '42px', fontSize: '13.5px' }}
              onClick={() => setActiveFilter('all')}
            >
              {t('browseAllLocal', 'Browse all local titles')}
            </button>
          </div>
        </div>
      ) : effFilter === 'favorites' && favoriteCount === 0 && !scanning && !walking ? (
        <div className="local-empty-state">
          <div className="local-empty-state__icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h3 className="local-empty-state__title">
            {t('noLocalFavoritesTitle', 'No favorites yet')}
          </h3>
          <p className="local-empty-state__desc">
            {t('noLocalFavoritesDesc', 'Tap the heart on any local movie or series poster to add it here.')}
          </p>
          <div className="local-empty-state__actions">
            <button
              type="button"
              className="local-btn local-btn--secondary"
              style={{ padding: '0 24px', height: '42px', fontSize: '13.5px' }}
              onClick={() => setActiveFilter('all')}
            >
              {t('browseAllLocal', 'Browse all local titles')}
            </button>
          </div>
        </div>
      ) : items.length === 0 && !scanning && !walking ? (
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
            {t('emptyLocalDesc', 'Point ynoTV at a folder. Add a Movies folder for films, or a Series folder laid out as one subfolder per show (with optional Season subfolders). We parse titles and enrich them with TMDB so they look the same as everything else here. We just remember the path; nothing is copied or moved.')}
          </p>
          <div className="local-empty-state__actions">
            {effFilter !== 'series' && (
              <button
                type="button"
                className="local-btn local-btn--primary"
                style={{ padding: '0 24px', height: '42px', fontSize: '13.5px' }}
                onClick={() => void handleAddFolder('movie')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                {t('chooseMovieFolder', 'Add Movies folder')}
              </button>
            )}
            {effFilter !== 'movies' && (
              <button
                type="button"
                className="local-btn local-btn--primary"
                style={{ padding: '0 24px', height: '42px', fontSize: '13.5px' }}
                onClick={() => void handleAddFolder('show')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                {t('chooseSeriesFolder', 'Add Series folder')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="local-grid-scroll flex-1 min-h-0 overflow-y-auto"
          onScroll={handleGridScroll}
          style={
            {
              '--local-poster-size': `${posterSize}px`,
              '--local-item-height': `${itemHeight}px`,
            } as React.CSSProperties
          }
        >
          <VirtualGrid
            ref={virtuosoRef}
            items={filteredGroups}
            scrollRef={scrollRef}
            minColumnWidth={posterSize}
            gapX={12}
            gapY={16}
            estimateRowHeight={itemHeight}
            getKey={(g) => (g.kind === 'movie' ? g.entry.id : g.key)}
            renderItem={(g, idx) => LocalGridItem(idx, g, gridContext)}
            onRangeChange={(range) => setVisibleRange(range)}
            overscan={4}
          />
        </div>
      )}

      {/* A-Z quick jump rail (name order only, like the category view) */}
      {filteredGroups.length > 0 && sortKey === 'name' && (
        <AlphabetRail
          currentLetter={currentLetter}
          availableLetters={availableLetters}
          onLetterSelect={handleLetterSelect}
          count={filteredGroups.length}
        />
      )}

      {/* Add to Playlist Modal (local movies/series use the same flow as VOD) */}
      {addToPlaylistTarget && addToPlaylistModalProps && (
        <AddToPlaylistModal
          isOpen={true}
          onClose={() => setAddToPlaylistTarget(null)}
          movie={addToPlaylistModalProps.movie}
          series={addToPlaylistModalProps.series}
          seasons={addToPlaylistModalProps.seasons}
          posterUrl={addToPlaylistModalProps.posterUrl}
          sourceName="Local"
        />
      )}

      {/* Episodes Picker Modal */}
      {episodesModalTarget && (
        <LocalEpisodesModal
          head={episodesModalTarget.head}
          episodes={episodesModalTarget.episodes}
          onClose={() => setEpisodesModalTarget(null)}
          onPlayEpisode={(ep) => {
            handlePlayEntry(ep, episodesModalTarget ? { key: episodesModalTarget.key || localShowKey(episodesModalTarget.head), head: episodesModalTarget.head } : undefined);
            setEpisodesModalTarget(null);
          }}
        />
      )}

      {/* Review unmatched items modal (per-series rows, match / remove / skip).
          The modal keeps its own working list, so removing or skipping one row
          advances to the next item without closing; it closes itself when the
          list is exhausted. */}
      {reviewTargets && (
        <ReviewUnmatchedModal
          groups={reviewTargets}
          onClose={() => setReviewTargets(null)}
          onMatch={(selected) => {
            setReviewTargets(null);
            openReviewMatch(selected);
          }}
          onRemove={(ids) => {
            removeLocalEntries(ids);
            showToast(t('removedSelectedItems', 'Removed selected items'));
          }}
          onSkip={handleReviewSkip}
        />
      )}

      {/* Identify / Match Fix Modal */}
      {identifyTarget && (
        <IdentifyModal
          target={identifyTarget}
          onClose={() => {
            if (resolvingRef.current) {
              // Close right after a successful resolve: the next queued group
              // (or null) was already set — don't clobber it.
              resolvingRef.current = false;
              return;
            }
            // Cancelling mid-queue discards the remaining review groups.
            identifyQueueRef.current = null;
            setIdentifyTarget(null);
          }}
          onResolved={handleIdentifyResolved}
          onSkip={handleIdentifySkip}
          onRemove={handleIdentifyRemove}
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
          setPendingFolderType(undefined);
        }}
      />

      {/* Folders Management Modal */}
      <LocalFoldersModal
        isOpen={foldersModalOpen}
        folderFilter={effFilter === 'movies' ? 'movie' : effFilter === 'series' ? 'show' : undefined}
        onClose={() => setFoldersModalOpen(false)}
        onRescanFolder={handleRescanSpecificFolder}
        onAddNewFolder={async (type) => {
          setFoldersModalOpen(false);
          await handleAddFolder(type);
        }}
        onRescanAllFolders={handleRescanAllFolders}
      />

      {/* File Not Found Modal */}
      <FileNotFoundModal
        isOpen={!!fileNotFoundTarget}
        entry={fileNotFoundTarget}
        onClose={() => setFileNotFoundTarget(null)}
        onRelocated={(_entry, _newPath) => {
          showToast(t('fileRelocated', 'File path updated.'));
          setFileNotFoundTarget(null);
        }}
        onRemoved={() => {
          showToast(t('itemRemoved', 'Item removed from library.'));
          setFileNotFoundTarget(null);
        }}
      />

      {/* Clean Unavailable Modal */}
      <CleanUnavailableModal
        isOpen={cleanModalOpen}
        onClose={() => setCleanModalOpen(false)}
        items={items}
        folders={scannedFolders}
        activeFilter={effFilter}
        onCleaned={(count) => {
          showToast(t('cleanedMissingItems', { count }));
        }}
      />

      {/* Full Page Detail View for Selected Item */}
      {currentDetailGroup && (
        <LocalDetail
          group={currentDetailGroup}
          onClose={() => setSelectedDetailGroup(null)}
          onPlay={(entry, seriesGroup) => handlePlayEntry(entry, seriesGroup)}
          onFixMatch={(target) => setIdentifyTarget(target)}
          onRefreshMetadata={handleRefreshMetadata}
          onRemove={(ids) => {
            removeLocalEntries(ids);
            setSelectedDetailGroup(null);
            showToast(t('itemRemoved'));
          }}
          onAddToPlaylist={(group) => {
            if (group.kind === 'movie') {
              setAddToPlaylistTarget({ kind: 'movie', entry: group.entry });
            } else {
              setAddToPlaylistTarget({ kind: 'show', key: group.key, head: group.head, episodes: group.episodes });
            }
          }}
        />
      )}

      {/* Undo bar — appears after a user edit/removal */}
      {undoVisible && hasUndo() && (
        <div className="local-undo-bar">
          <span className="local-undo-bar__text">
            {t('undoToastText', 'Change made — undo it?')}
          </span>
          <button
            type="button"
            className="local-undo-bar__btn"
            onClick={handleUndo}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: '5px' }}>
              <path d="M3 7v6h6" />
              <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
            </svg>
            {t('undoToastAction', 'Undo')}
          </button>
          <button
            type="button"
            className="local-undo-bar__dismiss"
            onClick={() => setUndoVisible(false)}
            title={t('common:dismiss', 'Dismiss')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
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
