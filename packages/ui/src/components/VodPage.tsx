import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import i18n from '../i18n';
import { isMouseBackButtonActive } from '../constants/shortcuts';
import { useSettingsStore } from '../stores/settingsStore';
import { HeroSection } from './vod/HeroSection';
import { HorizontalCarousel } from './vod/HorizontalCarousel';
import { VerticalSidebar } from './vod/VerticalSidebar';
import { VodBrowse } from './vod/VodBrowse';
import { RecentView } from './vod/RecentView';
import { FavoritesView } from './vod/FavoritesView';
import { PlaylistsView } from './vod/PlaylistsView';
import { useActivePlaylistStore } from '../stores/activePlaylistStore';
import type { PlaylistItem, Playlist } from '../stores/vodPlaylistStore';
import {
  isPlaylistItemHidden,
  playlistItemToVodInfo,
  recordPlaylistItemWatch,
  resolvePlaylistItem,
  applyPlaylistResolutions,
} from '../utils/playlistPlayback';
import { MovieDetail } from './vod/MovieDetail';
import { SeriesDetail } from './vod/SeriesDetail';
import { SourceContextMenu } from './SourceContextMenu';
import { ManageVodCategories } from './vod/ManageVodCategories';
import { HiddenTitlesModal } from './vod/HiddenTitlesModal';
import { useVodHiddenItemsStore } from '../stores/vodHiddenItemsStore';
import { useVodCategories, useRecentlyWatchedMovies, useRecentlyWatchedSeries } from '../hooks/useVod';
import { StreamingPlatformsRow } from './vod/StreamingPlatformsRow';
import { StreamingServiceView } from './stremio/StreamingServiceView';
import { StremioPersonDetail } from './stremio/StremioPersonDetail';
import type { StremioMeta } from '../types/stremio';
import { StremioHoverProvider } from '../contexts/StremioHoverContext';
import { StremioHoverCard } from './stremio/StremioHoverCard';
import './stremio/StremioHome.css';
import { useEnabledSources } from '../hooks/useChannels';
import { useVodFavoritesStore } from '../stores/vodFavoritesStore';
import { useVodMetadataOverridesStore } from '../stores/vodMetadataOverridesStore';
import {
  useCinemetaPopular,
  useCinemetaNew,
  useCinemetaFeatured,
  useCinemetaHero,
} from '../hooks/useCinemetaCatalogs';
import { useTmdbApiKey } from '../hooks/useTmdbLists';
import { getTmdbImageUrl, TMDB_BACKDROP_SIZES } from '../services/tmdb';
import {
  useMoviesCategory,
  useSetMoviesCategory,
  useMoviesSelectedItem,
  useSetMoviesSelectedItem,
  useMoviesSearchQuery,
  useSetMoviesSearchQuery,
  useSeriesCategory,
  useSetSeriesCategory,
  useSeriesSelectedItem,
  useSetSeriesSelectedItem,
  useSeriesSearchQuery,
  useSetSeriesSearchQuery,
  useSeriesSelectedSeason,
  useSetSeriesSelectedSeason,
} from '../stores/uiStore';
import type { StoredMovie, StoredSeries, StoredEpisode } from '../db';
import { removeFromRecentlyWatched, recordVodWatch, recordEpisodeWatch, getEpisodeProgress, type EpisodeWatchHistory, db } from '../db';
import { type MediaItem, type VodType, type VodPlayInfo } from '../types/media';
import { StalkerServerSearchView } from './vod/StalkerServerSearchView';
import { STALKER_SERVER_SEARCH_ID } from '../stores/stalkerSearchStore';
import { getStalkerSearchSources } from '../services/stalkerServerSearch';
import { type VodPlayerMode } from './vod/SplitPlayButton';
import { LocalTab } from './local/LocalTab';
import { LocalDetail } from './local/LocalDetail';
import { IdentifyModal } from './local/IdentifyModal';
import { AddToPlaylistModal } from './vod/AddToPlaylistModal';
import {
  readLocalLibrary,
  groupLocal,
  useLocalLibrary,
  localEntryToVodPlayInfo,
  localEntryToStoredEpisode,
  localEntryToStoredMovie,
  localGroupToStoredSeries,
  ensureLocalLibraryLoaded,
  removeLocalEntries,
  updateLocalEntries,
  extractEpisodeNumber,
  parseFilename,
} from '../services/local-library/local-library';
import type { LocalGroup, LocalEntry } from '../services/local-library/types';
import { clearTmdbMatchCache, invalidateTmdbIdMatchCache, invalidateTmdbMatchCache } from '../services/local-library/scan';
import './VodPage.css';

// Carousel row type for virtualization (all data pre-fetched)
type CarouselRow = {
  key: string;
  title: string;
  items: MediaItem[];
  loading?: boolean;
  progressData?: Map<string, number>; // Optional: media_id -> progress percent for progress bars
  isRecentlyWatched?: boolean;
  // For series only: episode info (season/episode/title)
  episodeData?: Map<string, { seasonNum?: number; episodeNum?: number; episodeTitle?: string }>;
};

// Context passed to Virtuoso components (must be defined outside render)
interface HomeVirtuosoContext {
  type: VodType;
  tmdbApiKey: string | null;
  featuredItems: MediaItem[];
  heroLoading: boolean;
  onItemClick: (item: MediaItem) => void;
  onHeroPlay: (item: MediaItem, targetMode?: VodPlayerMode) => void;
  onRemoveFromRecentlyWatched?: (item: MediaItem) => void;
  onPlayItem?: (item: MediaItem, seasonNum?: number, episodeNum?: number, episodeTitle?: string) => void;
  enabledStreamingServices: string[];
  onServiceClick: (service: string) => void;
  vodPlayerMode?: VodPlayerMode;
  onSelectVodPlayerMode?: (mode: VodPlayerMode) => void;
}

// Item renderer for carousels
const CarouselRowContent = (
  _index: number,
  row: CarouselRow,
  context: HomeVirtuosoContext | undefined
) => {
  if (!context) return null;
  const { 
    type, 
    onItemClick, 
    onRemoveFromRecentlyWatched,
    onPlayItem,
    enabledStreamingServices,
    onServiceClick
  } = context;

  if (row.key === 'streaming-platforms') {
    return (
      <StreamingPlatformsRow
        enabledServices={enabledStreamingServices}
        onServiceClick={onServiceClick}
      />
    );
  }

  return (
    <HorizontalCarousel
      title={row.title}
      items={row.items}
      type={type}
      onItemClick={onItemClick}
      onItemRemove={row.isRecentlyWatched ? onRemoveFromRecentlyWatched : undefined}
      loading={row.loading}
      progressData={row.progressData}
      isRecentlyWatched={row.isRecentlyWatched}
      episodeData={row.episodeData}
      onPlayItem={onPlayItem}
    />
  );
};

interface VodPageProps {
  type: VodType;
  onPlay?: (info: VodPlayInfo, targetMode?: VodPlayerMode) => void;
  onClose?: () => void;
  vodPlayerMode?: VodPlayerMode;
  onSelectVodPlayerMode?: (mode: VodPlayerMode) => void;
}

export function VodPage({ type, onPlay, onClose, vodPlayerMode, onSelectVodPlayerMode }: VodPageProps) {
  const shortcuts = useSettingsStore((s) => s.shortcuts);

  // Sidebar collapsed/expanded state — persisted per type (Movies vs Series)
  // so the collapse survives leaving the page
  const [sidebarVisible, setSidebarVisible] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(`ynotv:vodSidebarVisible:${type}`);
      return stored === null ? true : stored === 'true';
    } catch {
      return true;
    }
  });

  // Persist the sidebar state on change
  useEffect(() => {
    try {
      localStorage.setItem(`ynotv:vodSidebarVisible:${type}`, String(sidebarVisible));
    } catch {
      // ignore storage errors (private mode, quota, etc.)
    }
  }, [type, sidebarVisible]);

  // Context Menu & Management State (local, not persisted)
  const [contextMenu, setContextMenu] = useState<{ sourceId: string; sourceName: string; x: number; y: number } | null>(null);
  const [manageCategoriesSource, setManageCategoriesSource] = useState<{ id: string; name: string } | null>(null);
  const [showHiddenTitles, setShowHiddenTitles] = useState(false);

  // Streaming platform state
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const streamingCatalogsEnabled = useSettingsStore((s) => s.streamingCatalogsEnabled);
  const enabledStreamingServices = useSettingsStore((s) => s.enabledStreamingServices);
  const [prevViewState, setPrevViewState] = useState<{ categoryId: string | null; service: string | null } | null>(null);

  // Category state - use the appropriate store based on type
  const moviesCategory = useMoviesCategory();
  const setMoviesCategory = useSetMoviesCategory();
  const seriesCategory = useSeriesCategory();
  const setSeriesCategory = useSetSeriesCategory();

  // Selected item state - persisted in store for navigation resilience
  const moviesSelectedItem = useMoviesSelectedItem();
  const setMoviesSelectedItem = useSetMoviesSelectedItem();
  const seriesSelectedItem = useSeriesSelectedItem();
  const setSeriesSelectedItem = useSetSeriesSelectedItem();

  // Search query state - persisted in store
  const moviesSearchQuery = useMoviesSearchQuery();
  const setMoviesSearchQuery = useSetMoviesSearchQuery();
  const seriesSearchQuery = useSeriesSearchQuery();
  const setSeriesSearchQuery = useSetSeriesSearchQuery();

  // Selected season for series - persisted in store
  const seriesSelectedSeason = useSeriesSelectedSeason();
  const setSeriesSelectedSeason = useSetSeriesSelectedSeason();

  // Local cast detail view state
  const [activePersonId, setActivePersonId] = useState<number | null>(null);

  // Optional portal-side search (Stalker only, and off unless enabled in Settings).
  const stalkerServerSearchEnabled = useSettingsStore((s) => s.stalkerServerSearchEnabled);
  // null = not looked yet, so a stored Server Search selection is not thrown away before
  // the source list has been read.
  const [hasStalkerSource, setHasStalkerSource] = useState<boolean | null>(null);

  // Only look for portals while the feature is on: a button that opens an empty
  // picker is worse than no button, and non-Stalker installs should do no work at all.
  useEffect(() => {
    if (!stalkerServerSearchEnabled) {
      setHasStalkerSource(false);
      return;
    }
    let cancelled = false;
    getStalkerSearchSources()
      .then(list => {
        if (!cancelled) setHasStalkerSource(list.length > 0);
      })
      .catch(() => {
        if (!cancelled) setHasStalkerSource(false);
      });
    return () => { cancelled = true; };
  }, [stalkerServerSearchEnabled]);

  const showServerSearch = stalkerServerSearchEnabled && hasStalkerSource === true;

  // Use appropriate store values based on type
  const selectedCategoryId = type === 'movie' ? moviesCategory : seriesCategory;
  const setSelectedCategoryId = type === 'movie' ? setMoviesCategory : setSeriesCategory;

  // The tab and the view are gated on the same condition, but that only keeps the view
  // from opening a hidden tab — it does not clear a selection made while the tab existed.
  // With the sentinel still selected and the tab gone, the sidebar highlights nothing
  // while the page shows Home, so drop the selection and let both agree again.
  useEffect(() => {
    if (stalkerServerSearchEnabled && hasStalkerSource !== false) return;
    if (selectedCategoryId === STALKER_SERVER_SEARCH_ID) setSelectedCategoryId(null);
  }, [stalkerServerSearchEnabled, hasStalkerSource, selectedCategoryId, setSelectedCategoryId]);

  const selectedItem = type === 'movie' ? moviesSelectedItem : seriesSelectedItem;
  const setSelectedItem = type === 'movie' ? setMoviesSelectedItem : setSeriesSelectedItem;
  const searchQuery = type === 'movie' ? moviesSearchQuery : seriesSearchQuery;
  const setSearchQuery = type === 'movie' ? setMoviesSearchQuery : setSeriesSearchQuery;
  const selectedSeason = type === 'series' ? seriesSelectedSeason : undefined;
  const setSelectedSeason = type === 'series' ? setSeriesSelectedSeason : () => {};

  // Clear person ID if selectedItem changes
  useEffect(() => {
    setActivePersonId(null);
  }, [selectedItem]);

  const handleCastItemClick = useCallback((meta: StremioMeta) => {
    setActivePersonId(null);
    const targetType = meta.type;
    if (targetType === type) {
      setSelectedItem(null);
      setSearchQuery(meta.name);
      setSelectedCategoryId('all');
    } else {
      setSelectedItem(null);
      window.dispatchEvent(new CustomEvent('ynotv:search-vod', {
        detail: { type: targetType, title: meta.name }
      }));
    }
  }, [type, setSelectedItem, setSearchQuery, setSelectedCategoryId]);

  // TMDB API key for detail view enrichment (optional)
  const tmdbApiKey = useTmdbApiKey();

  // Cinemeta-based content for home page
  const { items: featuredItems, loading: heroLoading } = useCinemetaHero(type);
  const { items: popularItems, loading: popularLoading } = useCinemetaPopular(type);
  const { items: newItems, loading: newLoading } = useCinemetaNew(type);
  const { items: topRatedItems, loading: topRatedLoading } = useCinemetaFeatured(type);

  // Recently Watched - user's viewing history
  const { movies: recentlyWatchedMoviesData, loading: recentlyWatchedMoviesLoading } = useRecentlyWatchedMovies(20);
  const { series: recentlyWatchedSeriesData, loading: recentlyWatchedSeriesLoading } = useRecentlyWatchedSeries(20);
  
  // Extract items from RecentlyWatchedItem wrappers
  const recentlyWatchedItems = useMemo(
    () => (type === 'movie' 
      ? recentlyWatchedMoviesData.map(m => m.item)
      : recentlyWatchedSeriesData.map(s => s.item)),
    [type, recentlyWatchedMoviesData, recentlyWatchedSeriesData]
  );
  const recentlyWatchedLoading = type === 'movie' ? recentlyWatchedMoviesLoading : recentlyWatchedSeriesLoading;
  
  // Create progress map for Recently Watched items
  const recentlyWatchedProgressMap = useMemo(
    () => (type === 'movie'
      ? new Map(recentlyWatchedMoviesData.map(m => [m.item.stream_id, m.progress_percent]))
      : new Map(recentlyWatchedSeriesData.map(s => [s.item.series_id, s.progress_percent]))),
    [type, recentlyWatchedMoviesData, recentlyWatchedSeriesData]
  );

  // Create episode data map for Recently Watched series
  const recentlyWatchedEpisodeData = useMemo(
    () => (type === 'series'
      ? new Map(recentlyWatchedSeriesData.map(s => [s.item.series_id, { 
          seasonNum: s.season_num, 
          episodeNum: s.episode_num, 
          episodeTitle: s.episode_title 
        }]))
      : undefined),
    [type, recentlyWatchedSeriesData]
  );

  // Favorites - from Zustand persist store
  const enabledSourceIds = useEnabledSources();
  const allFavorites = useVodFavoritesStore((s) => s.favorites);
  const favoritesList = useMemo(
    () => allFavorites.filter(f => f.type === type),
    [allFavorites, type]
  );


  // Local library entries and groups
  const localEntries = useLocalLibrary();
  const localGroups = useMemo(() => groupLocal(localEntries), [localEntries]);

  const [identifyTarget, setIdentifyTarget] = useState<LocalEntry[] | null>(null);
  const [addToPlaylistTarget, setAddToPlaylistTarget] = useState<
    | { kind: 'movie'; entry: LocalEntry }
    | { kind: 'show'; key: string; head: LocalEntry; episodes: LocalEntry[] }
    | null
  >(null);

  const selectedLocalGroup = useMemo<LocalGroup | null>(() => {
    if (!selectedItem) return null;
    const isLocal =
      selectedItem.source_id === 'local' ||
      ('series_id' in selectedItem && typeof selectedItem.series_id === 'string' && selectedItem.series_id.startsWith('local_')) ||
      ('stream_id' in selectedItem && typeof selectedItem.stream_id === 'string' && selectedItem.stream_id.startsWith('local_'));
    if (!isLocal) return null;

    if ('stream_id' in selectedItem) {
      const movie = selectedItem as StoredMovie;
      const rawId = movie.stream_id.startsWith('local_') ? movie.stream_id.slice(6) : movie.stream_id;
      return (
        localGroups.find(
          (g) =>
            g.kind === 'movie' &&
            (g.entry.id === rawId ||
              g.entry.id === movie.stream_id ||
              (movie.direct_url && g.entry.path.toLowerCase() === movie.direct_url.toLowerCase()))
        ) || null
      );
    } else {
      const series = selectedItem as StoredSeries;
      const rawKey = series.series_id.startsWith('local_') ? series.series_id.slice(6) : series.series_id;
      return (
        localGroups.find(
          (g) =>
            g.kind === 'show' &&
            (g.key === rawKey ||
              'local_' + g.key === series.series_id ||
              (series.direct_url && g.head.path.toLowerCase() === series.direct_url.toLowerCase()) ||
              g.episodes.some((ep) => ep.id === rawKey || 'local_' + ep.id === series.series_id))
        ) || null
      );
    }
  }, [selectedItem, localGroups]);

  const addToPlaylistModalProps = useMemo(() => {
    if (!addToPlaylistTarget) return null;
    if (addToPlaylistTarget.kind === 'movie') {
      const movie = localEntryToStoredMovie(addToPlaylistTarget.entry);
      return {
        movie,
        series: null as StoredSeries | null,
        seasons: {} as Record<number, StoredEpisode[]>,
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

  const [favoriteItems, setFavoriteItems] = useState<(StoredMovie | StoredSeries)[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);

  // Load full item data from DB when favorites view is selected
  useEffect(() => {
    if (selectedCategoryId !== 'favorites' || favoritesList.length === 0) {
      setFavoriteItems([]);
      return;
    }

    let cancelled = false;
    const loadItems = async () => {
      setFavoritesLoading(true);
      try {
        // Local library entries live in their own table (not vodMovies/
        // vodSeries), so load them before diffing favorites.
        await ensureLocalLibraryLoaded();
        const dbInstance = await (db as any).dbPromise;
        const ids = favoritesList.map(f => f.id);
        const placeholders = ids.map(() => '?').join(',');

        if (type === 'movie') {
          const items: StoredMovie[] = await dbInstance.select(
            `SELECT * FROM vodMovies WHERE stream_id IN (${placeholders})`,
            ids
          );
          // Local library movies are keyed by `local_<path>`; favorites whose
          // ids match are loaded from the local library (never source-filtered),
          // automatically hiding unavailable local files.
          const localMovies: StoredMovie[] = localEntries
            .filter(
              (e) => e.type === 'movie' && !e.unavailable && favoritesList.some((f) => f.id === `local_${e.id}`)
            )
            .map((e) => localEntryToStoredMovie(e));
          if (!cancelled) {
            const filteredItems = enabledSourceIds
              ? items.filter(item => enabledSourceIds.has(item.source_id))
              : items;
            const merged = [...filteredItems, ...localMovies];
            const orderMap = new Map(ids.map((id, i) => [id, i]));
            merged.sort((a, b) => (orderMap.get(a.stream_id) ?? Infinity) - (orderMap.get(b.stream_id) ?? Infinity));
            setFavoriteItems(merged);
          }
        } else {
          const items: StoredSeries[] = await dbInstance.select(
            `SELECT * FROM vodSeries WHERE series_id IN (${placeholders})`,
            ids
          );
          const localSeries: StoredSeries[] = [];
          for (const g of localGroups) {
            if (g.kind !== 'show') continue;
            const isUnavailable = g.episodes.length > 0 && g.episodes.every((e) => e.unavailable);
            if (!isUnavailable && favoritesList.some((f) => f.id === `local_${g.key}`)) {
              localSeries.push(localGroupToStoredSeries(g));
            }
          }
          if (!cancelled) {
            const filteredItems = enabledSourceIds
              ? items.filter(item => enabledSourceIds.has(item.source_id))
              : items;
            const merged = [...filteredItems, ...localSeries];
            const orderMap = new Map(ids.map((id, i) => [id, i]));
            merged.sort((a, b) => (orderMap.get(a.series_id) ?? Infinity) - (orderMap.get(b.series_id) ?? Infinity));
            setFavoriteItems(merged);
          }
        }
      } catch (error) {
        console.error('[VodPage] Error loading favorites:', error);
        if (!cancelled) setFavoriteItems([]);
      } finally {
        if (!cancelled) setFavoritesLoading(false);
      }
    };

    loadItems();
    return () => { cancelled = true; };
  }, [selectedCategoryId, favoritesList, type, enabledSourceIds, localEntries, localGroups]);

  // VOD categories
  const { categories } = useVodCategories(type);

  const handlePlayPlaylistItem = useCallback(async (item: PlaylistItem, playlist: Playlist, isShuffle?: boolean) => {
    // Resolve every item against the CURRENT source rows before queuing, so a
    // re-sync or credential change (new stream URLs) or a metadata edit is
    // picked up at play time instead of playing a stale snapshot. Item ids are
    // preserved, so queue positions and progress tracking are unchanged.
    const resolved = await Promise.all(playlist.items.map((i) => resolvePlaylistItem(i)));
    // Persist the fresh metadata back into the store (and prune permanently-
    // gone items), so exports/imports carry up-to-date data.
    applyPlaylistResolutions(resolved);
    const resolvedById = new Map(resolved.map((i) => [i.id, i]));
    const resolvedItem = resolvedById.get(item.id) ?? item;

    // Skip items whose source was removed/disabled or local file is unavailable
    // so the queue never tries to play an unavailable stream. Keeps the played
    // item's own queue position.
    const queueItems = resolved.filter((i) => !isPlaylistItemHidden(i, enabledSourceIds, localEntries));
    useActivePlaylistStore.getState().startPlayback(
      playlist.id,
      playlist.name,
      queueItems,
      queueItems.findIndex(i => i.id === item.id),
      isShuffle
    );

    // Record the watch (Recent rail + episode progress) like normal VOD
    // playback does, so playlist plays show up and resume properly.
    void recordPlaylistItemWatch(resolvedItem);
    onPlay?.(playlistItemToVodInfo(resolvedItem), vodPlayerMode);
  }, [onPlay, vodPlayerMode, enabledSourceIds, localEntries]);

  // Get selected category name for VodBrowse
  const selectedCategory = categories.find(c => c.category_id === selectedCategoryId);

  // Build carousel rows for virtualization
  // Only includes rows that have content (or are still loading)
  const carouselRows = useMemo((): CarouselRow[] => {
    const rows: CarouselRow[] = [];

    // Recently Watched (shown first if available)
    if (recentlyWatchedItems.length > 0) {
      rows.push({
        key: 'recently-watched',
        title: i18n.t('vod:recentlyWatched'),
        items: recentlyWatchedItems,
        loading: false,
        progressData: recentlyWatchedProgressMap,
        isRecentlyWatched: true,
        episodeData: recentlyWatchedEpisodeData,
      });
    } else if (recentlyWatchedLoading) {
      rows.push({
        key: 'recently-watched',
        title: i18n.t('vod:recentlyWatched'),
        items: [],
        loading: true,
      });
    }

    // Streaming Platforms Row
    if (tmdbApiKey && streamingCatalogsEnabled && enabledStreamingServices.length > 0) {
      rows.push({
        key: 'streaming-platforms',
        title: i18n.t('vod:streamingPlatforms'),
        items: [],
      });
    }

    // Popular (Cinemeta "top" catalog)
    if (popularItems.length > 0) {
      rows.push({
        key: 'popular',
        title: i18n.t('vod:popular'),
        items: popularItems,
        loading: false,
      });
    } else if (popularLoading) {
      rows.push({
        key: 'popular',
        title: i18n.t('vod:popular'),
        items: [],
        loading: true,
      });
    }

    // New Releases (Cinemeta "year" catalog)
    if (newItems.length > 0) {
      rows.push({
        key: 'new',
        title: i18n.t('vod:newReleases'),
        items: newItems,
        loading: false,
      });
    } else if (newLoading) {
      rows.push({
        key: 'new',
        title: i18n.t('vod:newReleases'),
        items: [],
        loading: true,
      });
    }

    // Featured (Cinemeta "imdbRating" catalog)
    if (topRatedItems.length > 0 || topRatedLoading) {
      rows.push({
        key: 'featured',
        title: i18n.t('vod:featured'),
        items: topRatedItems,
        loading: topRatedLoading,
      });
    }

    return rows;
  }, [
    recentlyWatchedItems, recentlyWatchedLoading, recentlyWatchedProgressMap,
    popularItems, popularLoading,
    newItems, newLoading,
    topRatedItems, topRatedLoading,
    type,
  ]);

  // Load user-corrected VOD metadata once so grids and detail views show
  // edited titles/posters instead of briefly flashing the provider values.
  useEffect(() => {
    void useVodMetadataOverridesStore.getState().hydrate();
    void useVodHiddenItemsStore.getState().hydrate();
  }, []);

  const handleItemClick = useCallback((item: MediaItem) => {
    if (item.source_id === 'tmdb' || item.source_id === 'cinemeta') {
      const title = item.title || item.name || '';
      if (title) {
        setPrevViewState({ categoryId: selectedCategoryId, service: selectedService });
        setSearchQuery(title);
        setSelectedCategoryId('all');
        setSelectedItem(null);
        setSelectedSeason(undefined);
      }
      return;
    }
    
    // Check if this is a series from Recently Watched and get its season
    if (type === 'series') {
      const seriesId = (item as StoredSeries).series_id;
      const episodeData = recentlyWatchedEpisodeData?.get(seriesId);
      if (episodeData?.seasonNum) {
        setSelectedSeason(episodeData.seasonNum);
      } else {
        setSelectedSeason(undefined);
      }
    } else {
      setSelectedSeason(undefined);
    }
    
    setSelectedItem(item);
  }, [type, recentlyWatchedEpisodeData, selectedCategoryId, selectedService]);

  // Handle clicks from Recent view (includes season/episode info for series)
  const handleRecentItemClick = useCallback((item: MediaItem, seasonNum?: number, episodeNum?: number, episodeTitle?: string) => {
    if (item.source_id === 'tmdb' || item.source_id === 'cinemeta') {
      const title = item.title || item.name || '';
      if (title) {
        setPrevViewState({ categoryId: selectedCategoryId, service: selectedService });
        setSearchQuery(title);
        setSelectedCategoryId('all');
        setSelectedItem(null);
        setSelectedSeason(undefined);
      }
      return;
    }
    
    // For series, use the provided season/episode info from recently watched
    if (type === 'series' && seasonNum) {
      setSelectedSeason(seasonNum);
    } else {
      setSelectedSeason(undefined);
    }
    
    setSelectedItem(item);
  }, [type, selectedCategoryId, selectedService]);

  const handleStreamingItemClick = useCallback((item: any) => {
    const title = item.name || item.title || '';
    if (title) {
      setPrevViewState({ categoryId: selectedCategoryId, service: selectedService });
      setSearchQuery(title);
      setSelectedCategoryId('all');
      setSelectedItem(null);
      setSelectedSeason(undefined);
      setSelectedService(null);
    }
  }, [selectedCategoryId, selectedService, setSearchQuery, setSelectedCategoryId, setSelectedItem, setSelectedSeason, setSelectedService]);

  const handlePlay = useCallback((info: VodPlayInfo, targetMode?: VodPlayerMode) => {
    if (onPlay) {
      onPlay(info, targetMode);
    }
  }, [onPlay]);

  const handleRemoveFromRecentlyWatched = useCallback(async (item: MediaItem) => {
    const mediaId = type === 'movie' 
      ? (item as StoredMovie).stream_id 
      : (item as StoredSeries).series_id;
    try {
      await removeFromRecentlyWatched(mediaId, type);
    } catch (error) {
      console.error('[VodPage] Failed to remove from Recently Watched:', error);
    }
  }, [type]);

  const handleCloseDetail = useCallback(() => {
    setSelectedItem(null);
    setSelectedSeason(undefined);
  }, []);

  // Handle hero play button - movies play directly, series open detail
  const handleHeroPlay = useCallback((item: MediaItem, targetMode?: VodPlayerMode) => {
    if (item.source_id === 'tmdb' || item.source_id === 'cinemeta') {
      const title = item.title || item.name || '';
      if (title) {
        setSearchQuery(title);
        setSelectedCategoryId('all');
        setSelectedItem(null);
      }
      return;
    }

    if (type === 'movie') {
      const movie = item as StoredMovie;
      // Record watch before playing
      console.log('[VodPage] Recording watch for movie:', movie.stream_id, movie.title || movie.name);
      void recordVodWatch(
        movie.stream_id,
        'movie',
        movie.source_id,
        movie.title || movie.name || 'Unknown',
        movie.stream_icon
      ).then(() => {
        console.log('[VodPage] ✅ Watch recorded successfully');
      }).catch(err => {
        console.error('[VodPage] ❌ Failed to record watch:', err);
      });
      console.log('[VodPage] Calling handlePlay with mediaId:', movie.stream_id);
      handlePlay({
        url: movie.direct_url,
        title: movie.title || movie.name,
        year: movie.year || movie.release_date?.slice(0, 4),
        plot: movie.plot,
        type: 'movie',
        source_id: movie.source_id,
        mediaId: movie.stream_id,  // Add media ID for progress tracking
        tmdbId: movie.tmdb_id,
        imdbId: movie.imdb_id,
      }, targetMode);
    } else {
      setSelectedItem(item);
    }
  }, [type, handlePlay]);

  // Direct play from card play button (bypasses detail page)
  const handleDirectPlayItem = useCallback(async (
    item: MediaItem,
    seasonNum?: number,
    episodeNum?: number,
    episodeTitle?: string,
    targetMode?: VodPlayerMode
  ) => {
    if (item.source_id === 'tmdb' || item.source_id === 'cinemeta') {
      handleRecentItemClick(item, seasonNum, episodeNum, episodeTitle);
      return;
    }

    if (type === 'movie') {
      const movie = item as StoredMovie;
      void recordVodWatch(
        movie.stream_id,
        'movie',
        movie.source_id,
        movie.title || movie.name || 'Unknown',
        movie.stream_icon
      ).catch(console.error);

      handlePlay({
        url: movie.direct_url,
        title: movie.title || movie.name,
        year: movie.year || movie.release_date?.slice(0, 4),
        plot: movie.plot,
        type: 'movie',
        source_id: movie.source_id,
        mediaId: movie.stream_id,
        // Mirror MovieDetail: absolute backdrop URL (or provider poster).
        backdropUrl: movie.backdrop_path
          ? (getTmdbImageUrl(movie.backdrop_path, TMDB_BACKDROP_SIZES.large) || movie.stream_icon || undefined)
          : (movie.stream_icon || undefined),
        tmdbId: movie.tmdb_id,
        imdbId: movie.imdb_id,
      }, targetMode);
    } else {
      const series = item as StoredSeries;
      try {
        const dbInstance = await (db as any).dbPromise;
        let episodes: StoredEpisode[] = [];

        if (series.source_id === 'local' || series.series_id.startsWith('local_')) {
          const localEntries = readLocalLibrary();
          const groups = groupLocal(localEntries);
          const targetKey = series.series_id.replace(/^local_/, '').toLowerCase();
          const matchingGroup = groups.find(
            (g) => g.kind === 'show' && (
              g.key.toLowerCase() === targetKey ||
              g.key.toLowerCase().replace(/[^a-z0-9]+/g, '_') === targetKey.replace(/[^a-z0-9]+/g, '_')
            )
          );
          if (matchingGroup && matchingGroup.kind === 'show') {
            episodes = matchingGroup.episodes
              .slice()
              .sort((a, b) => (a.season ?? 1) - (b.season ?? 1) || (a.episode ?? 1) - (b.episode ?? 1))
              .map((ep) =>
                localEntryToStoredEpisode(ep, series.series_id, matchingGroup.head.title)
              );
          }
        } else {
          episodes = await dbInstance.select(
            'SELECT * FROM vodEpisodes WHERE series_id = ? ORDER BY season_num, episode_num',
            [series.series_id]
          );
        }

        if (!episodes || episodes.length === 0) {
          handleRecentItemClick(series, seasonNum, episodeNum, episodeTitle);
          return;
        }

        const epHistory: EpisodeWatchHistory[] = await dbInstance.select(
          'SELECT * FROM episode_history WHERE LOWER(series_id) = LOWER(?) OR LOWER(series_id) = LOWER(?)',
          [series.series_id, `local_${series.series_id.replace(/^local_/, '').replace(/[^a-z0-9]+/g, '_')}`]
        );
        const epHistMap = new Map(epHistory.map(eh => [eh.episode_id, eh]));

        let targetEp: StoredEpisode | undefined;
        if (seasonNum !== undefined && episodeNum !== undefined) {
          targetEp = episodes.find(e => e.season_num === seasonNum && e.episode_num === episodeNum);
        }

        if (!targetEp) {
          for (const ep of episodes) {
            const eh = epHistMap.get(ep.id);
            const dur = eh?.total_duration ?? 0;
            const pos = eh?.progress_seconds ?? 0;
            const isCompleted = eh ? (eh.completed === 1 || (dur > 0 && pos / dur >= 0.90)) : false;
            if (!isCompleted) {
              targetEp = ep;
              break;
            }
          }
        }

        if (!targetEp) {
          targetEp = episodes[0];
        }

        const progress = epHistMap.get(targetEp.id);
        const isCompleted = progress ? (progress.completed === 1 || ((progress.total_duration ?? 0) > 0 && (progress.progress_seconds ?? 0) / (progress.total_duration ?? 1) >= 0.95)) : false;
        const resumePosition = !isCompleted && progress && (progress.progress_seconds ?? 0) > 10 ? (progress.progress_seconds ?? 0) : 0;
        const epDuration = targetEp.duration || (targetEp.info?.duration ? Number(targetEp.info.duration) : 0) || 0;

        void recordVodWatch(
          series.series_id,
          'series',
          series.source_id,
          series.title || series.name || 'Unknown',
          series.cover || (series as any).stream_icon,
          targetEp.season_num,
          targetEp.episode_num,
          targetEp.title || `Episode ${targetEp.episode_num}`
        ).catch(console.error);

        void recordEpisodeWatch(
          targetEp.id,
          series.series_id,
          series.source_id,
          targetEp.season_num,
          targetEp.episode_num,
          targetEp.title || `Episode ${targetEp.episode_num}`,
          resumePosition,
          epDuration
        ).catch(console.error);

        handlePlay({
          url: targetEp.direct_url,
          title: series.title || series.name,
          year: series.year || series.release_date?.slice(0, 4),
          plot: targetEp.plot || series.plot,
          type: 'series',
          episodeInfo: `S${targetEp.season_num} E${targetEp.episode_num}${targetEp.title ? ` · ${targetEp.title}` : ''}`,
          source_id: series.source_id,
          mediaId: `${series.series_id}_ep_${targetEp.id}`,
          seriesId: series.series_id,
          seasonNum: targetEp.season_num,
          episodeNum: targetEp.episode_num,
          episodeId: targetEp.id,
          posterUrl: series.cover || (series as any).stream_icon || (series as any).poster || undefined,
          // backdrop_path is often a relative TMDB path (e.g. /abc123.jpg) or
          // a provider-relative path — wrap it so the image URL is absolute;
          // fall back to the cover like SeriesDetail does.
          backdropUrl: series.backdrop_path
            ? (getTmdbImageUrl(series.backdrop_path, TMDB_BACKDROP_SIZES.large) || series.cover || undefined)
            : (series.cover || undefined),
          tmdbId: series.tmdb_id,
          imdbId: series.imdb_id,
        }, targetMode);
      } catch (err) {
        console.error('[VodPage] Direct play series episode failed:', err);
        handleRecentItemClick(series, seasonNum, episodeNum, episodeTitle);
      }
    }
  }, [type, handlePlay, handleRecentItemClick]);

  // Memoized context for Virtuoso to prevent unnecessary re-renders
  const homeVirtuosoContext = useMemo((): HomeVirtuosoContext => ({
    type,
    tmdbApiKey: null,
    featuredItems,
    heroLoading,
    onItemClick: handleItemClick,
    onHeroPlay: handleHeroPlay,
    onRemoveFromRecentlyWatched: handleRemoveFromRecentlyWatched,
    onPlayItem: handleDirectPlayItem,
    enabledStreamingServices,
    onServiceClick: setSelectedService,
    vodPlayerMode,
    onSelectVodPlayerMode,
  }), [type, featuredItems, heroLoading, handleItemClick, handleHeroPlay, handleRemoveFromRecentlyWatched, handleDirectPlayItem, enabledStreamingServices, vodPlayerMode, onSelectVodPlayerMode]);

  // Handle category selection - also close detail view, clear search and streaming service view
  const handleCategorySelect = useCallback((id: string | null) => {
    setSelectedCategoryId(id);
    setSelectedItem(null);
    setSearchQuery('');
    setSelectedService(null);
    setPrevViewState(null);
  }, [setSelectedCategoryId, setSearchQuery]);

  const handleSidebarBack = useCallback(() => {
    if (searchQuery.trim() && prevViewState) {
      setSearchQuery('');
      setSelectedCategoryId(prevViewState.categoryId);
      setSelectedService(prevViewState.service);
      setPrevViewState(null);
    } else if (selectedService) {
      setSelectedService(null);
    } else {
      if (onClose) {
        onClose();
      }
    }
  }, [searchQuery, prevViewState, selectedService, onClose]);

  // Handle mouse back button and browser back - close detail view
  useEffect(() => {
    const handleMouseBack = (e: MouseEvent) => {
      if (isMouseBackButtonActive(shortcuts, e.button)) {
        if (activePersonId) {
          e.preventDefault();
          e.stopPropagation();
          setActivePersonId(null);
        } else if (selectedItem) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedItem(null);
        } else if (selectedService) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedService(null);
        } else if (searchQuery.trim() && prevViewState) {
          e.preventDefault();
          e.stopPropagation();
          setSearchQuery('');
          setSelectedCategoryId(prevViewState.categoryId);
          setSelectedService(prevViewState.service);
          setPrevViewState(null);
        } else if (onClose) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }
    };

    const handlePopState = () => {
      if (activePersonId) {
        setActivePersonId(null);
      } else if (selectedItem) {
        setSelectedItem(null);
      } else if (selectedService) {
        setSelectedService(null);
      }
    };

    window.addEventListener('mousedown', handleMouseBack);
    window.addEventListener('popstate', handlePopState);

    // Push state when opening detail so back button works
    if (selectedItem || activePersonId || selectedService) {
      window.history.pushState({ vodDetail: true }, '');
    }

    return () => {
      window.removeEventListener('mousedown', handleMouseBack);
      window.removeEventListener('popstate', handlePopState);
    };
  }, [
    shortcuts,
    selectedItem,
    activePersonId,
    selectedService,
    searchQuery,
    prevViewState,
    onClose,
    setSelectedItem,
    setSelectedService,
    setSearchQuery,
    setSelectedCategoryId,
    setPrevViewState,
  ]);

  // Labels
  const typeLabel = type === 'movie' ? i18n.t('vod:movies') : i18n.t('vod:series');
  const browseType = type === 'movie' ? 'movies' : 'series';

  const sidebarCategories = useMemo(
    () => categories.map(c => ({ id: c.category_id, name: c.name, source_id: c.source_id })),
    [categories]
  );

  return (
    <div className="vod-page">
      {/* Sidebar: Categories + Search + Back */}
      <VerticalSidebar
        categories={sidebarCategories}
        selectedId={selectedCategoryId}
        onSelect={handleCategorySelect}
        type={type}
        onBack={handleSidebarBack}
        searchQuery={searchQuery}
        onSearchChange={(query) => {
          if (query.trim() && !searchQuery.trim() && !prevViewState) {
            setPrevViewState({ categoryId: selectedCategoryId, service: selectedService });
          }
          setSearchQuery(query);
          if (query.trim() && selectedCategoryId === null) {
            setSelectedCategoryId('all');
          }
        }}
        onSearchSubmit={() => {
          if (searchQuery.trim() && selectedCategoryId === null) {
            setSelectedCategoryId('all');
          }
        }}
        onContextMenu={(e, sourceId, sourceName) => {
          setContextMenu({ sourceId, sourceName, x: e.clientX, y: e.clientY });
        }}
        visible={sidebarVisible}
        onClose={() => setSidebarVisible(false)}
        onShow={() => setSidebarVisible(true)}
        showServerSearch={showServerSearch}
      />        {/* Main content */}
        <main className="vod-page__content">
        {selectedService ? (
          <StremioHoverProvider>
            <StreamingServiceView
              service={selectedService}
              type={type}
              onBack={() => setSelectedService(null)}
              onItemClick={handleStreamingItemClick}
            />
            <StremioHoverCard />
          </StremioHoverProvider>
        ) : selectedCategoryId === STALKER_SERVER_SEARCH_ID && showServerSearch ? (
          // Portal-side search: results replace the browse grid, and their state is
          // cached in the session store so returning from a detail page restores them.
          <StalkerServerSearchView type={browseType} onOpenItem={handleItemClick} />
        ) : selectedCategoryId === 'all' ? (
          // All items: Virtualized grid with no filter
          <VodBrowse
            type={browseType}
            categoryId={null}
            categoryName={`All ${typeLabel}`}
            search={searchQuery || undefined}
            onItemClick={handleItemClick}
          />
        ) : selectedCategoryId === 'recent' ? (
          // Recent view: Recently watched items with progress
          <RecentView
            type={type}
            items={type === 'movie' ? recentlyWatchedMoviesData : recentlyWatchedSeriesData}
            loading={recentlyWatchedLoading}
            onItemClick={handleRecentItemClick}
            onRemove={handleRemoveFromRecentlyWatched}
            onPlayItem={handleDirectPlayItem}
          />
        ) : selectedCategoryId === 'favorites' ? (
          <FavoritesView
            type={type}
            items={favoriteItems}
            loading={favoritesLoading}
            onItemClick={handleItemClick}
          />
        ) : selectedCategoryId === 'playlists' ? (
          <PlaylistsView onPlayPlaylistItem={handlePlayPlaylistItem} />
        ) : selectedCategoryId === 'local' ? (
          <LocalTab
            initialFilter={type === 'movie' ? 'movies' : 'series'}
            lockFilter={true}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onPlayVod={(info) => handlePlay(info, vodPlayerMode)}
          />
        ) : selectedCategoryId && selectedCategory ? (
          // Category view: Virtualized grid filtered by category
          <VodBrowse
            type={browseType}
            categoryId={selectedCategoryId}
            categoryName={selectedCategory.name}
            search={searchQuery || undefined}
            onItemClick={handleItemClick}
          />
        ) : (
          // Home view: Hero + carousels
          <div className="vod-page__home">
            {featuredItems.length > 0 && (
              <HeroSection
                items={featuredItems}
                type={type}
                onPlay={handleHeroPlay}
                onMoreInfo={handleItemClick}
                loading={heroLoading}
                vodPlayerMode={vodPlayerMode}
                onSelectVodPlayerMode={onSelectVodPlayerMode}
              />
            )}
            <div className="vod-page__carousels pb-8">
              {carouselRows.map((row, index) => (
                <div key={row.key} className="vod-page__carousel-slot">
                  {CarouselRowContent(index, row, homeVirtuosoContext)}
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Local Detail View for Local Movies & Series */}
      {selectedLocalGroup && (
        <LocalDetail
          group={selectedLocalGroup}
          onClose={handleCloseDetail}
          onPlay={(entry, seriesGroup) => {
            const info = localEntryToVodPlayInfo(entry, seriesGroup);
            handlePlay(info, vodPlayerMode);
          }}
          onFixMatch={(target) => setIdentifyTarget(target)}
          onRefreshMetadata={(entries) => {
            if (entries.length === 0) return;
            for (const e of entries) {
              if (e.tmdbId) {
                invalidateTmdbIdMatchCache(e.tmdbId, e.type);
              }
              const parsed = parseFilename(e.filename);
              invalidateTmdbMatchCache(parsed.title, parsed.year, parsed.type);
            }
          }}
          onRemove={(ids) => {
            removeLocalEntries(ids);
            handleCloseDetail();
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

      {/* Identify / Match Fix Modal */}
      {identifyTarget && (
        <IdentifyModal
          target={identifyTarget}
          onClose={() => setIdentifyTarget(null)}
          onResolved={(ids, resolution) => {
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
                reviewSkipped: false,
                metadataLocked: true,
              };
            });
            setIdentifyTarget(null);
          }}
          onSkip={() => setIdentifyTarget(null)}
          onRemove={(ids) => {
            removeLocalEntries(ids);
            setIdentifyTarget(null);
            handleCloseDetail();
          }}
        />
      )}

      {/* Add To Playlist Modal */}
      {addToPlaylistModalProps && (
        <AddToPlaylistModal
          isOpen={true}
          onClose={() => setAddToPlaylistTarget(null)}
          movie={addToPlaylistModalProps.movie}
          series={addToPlaylistModalProps.series}
          seasons={addToPlaylistModalProps.seasons}
          posterUrl={addToPlaylistModalProps.posterUrl}
        />
      )}

      {/* Detail modal (non-local) */}
      {!selectedLocalGroup && selectedItem && type === 'movie' && (
        <MovieDetail
          movie={selectedItem as StoredMovie}
          onClose={handleCloseDetail}
          vodPlayerMode={vodPlayerMode}
          onSelectVodPlayerMode={onSelectVodPlayerMode}
          onPlay={(movie, plot, backdropUrl, logoUrl, targetMode) => {
            // Record watch before playing
            void recordVodWatch(
              movie.stream_id,
              'movie',
              movie.source_id,
              movie.title || movie.name || 'Unknown',
              movie.stream_icon
            );
            handlePlay({
              url: movie.direct_url,
              title: movie.title || movie.name,
              year: movie.year || movie.release_date?.slice(0, 4),
              plot: plot || movie.plot,
              type: 'movie',
              source_id: movie.source_id,
              mediaId: movie.stream_id,  // Add media ID for progress tracking
              posterUrl: movie.stream_icon || (movie as any).cover || (movie as any).poster || undefined,
              backdropUrl: backdropUrl || undefined,
              logoUrl: logoUrl || undefined,
              tmdbId: movie.tmdb_id,
              imdbId: movie.imdb_id,
            }, targetMode);
          }}
          apiKey={tmdbApiKey}
          onCastClick={(personId) => setActivePersonId(personId)}
        />
      )}
      {!selectedLocalGroup && selectedItem && type === 'series' && (
        <SeriesDetail
          series={selectedItem as StoredSeries}
          onClose={handleCloseDetail}
          vodPlayerMode={vodPlayerMode}
          onSelectVodPlayerMode={onSelectVodPlayerMode}
          onPlayEpisode={(info, targetMode) => handlePlay(info, targetMode)}
          apiKey={tmdbApiKey}
          initialSeason={selectedSeason}
          onCastClick={(personId) => setActivePersonId(personId)}
        />
      )}

      {/* Local VOD Cast detail overlay */}
      {activePersonId && (
        <div className="vod-cast-detail-overlay">
          <StremioPersonDetail
            personId={activePersonId}
            onBack={() => setActivePersonId(null)}
            onItemClick={handleCastItemClick}
          />
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <SourceContextMenu
          sourceId={contextMenu.sourceId}
          sourceName={contextMenu.sourceName}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          onManageVodCategories={(id, name) => {
            setManageCategoriesSource({ id, name });
          }}
          onManageHiddenTitles={() => setShowHiddenTitles(true)}
        />
      )}

      {/* Hidden titles (movies/series the user hid) */}
      {showHiddenTitles && (
        <HiddenTitlesModal onClose={() => setShowHiddenTitles(false)} />
      )}

      {/* Manage VOD Categories Modal */}
      {manageCategoriesSource && (
        <ManageVodCategories
          sourceId={manageCategoriesSource.id}
          sourceName={manageCategoriesSource.name}
          onClose={() => setManageCategoriesSource(null)}
        />
      )}
    </div>
  );
}

export default VodPage;
