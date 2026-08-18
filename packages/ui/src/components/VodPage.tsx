import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import i18n from '../i18n';
import { isMouseBackButtonActive } from '../constants/shortcuts';
import { useSettingsStore } from '../stores/settingsStore';
import { Virtuoso } from 'react-virtuoso';
import { HeroSection } from './vod/HeroSection';
import { HorizontalCarousel } from './vod/HorizontalCarousel';
import { VerticalSidebar } from './vod/VerticalSidebar';
import { VodBrowse } from './vod/VodBrowse';
import { RecentView } from './vod/RecentView';
import { FavoritesView } from './vod/FavoritesView';
import { PlaylistsView } from './vod/PlaylistsView';
import { useActivePlaylistStore } from '../stores/activePlaylistStore';
import type { PlaylistItem, Playlist } from '../stores/vodPlaylistStore';
import { isPlaylistItemHidden, playlistItemToVodInfo, recordPlaylistItemWatch } from '../utils/playlistPlayback';
import { MovieDetail } from './vod/MovieDetail';
import { SeriesDetail } from './vod/SeriesDetail';
import { SourceContextMenu } from './SourceContextMenu';
import { ManageVodCategories } from './vod/ManageVodCategories';
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
import { type VodPlayerMode } from './vod/SplitPlayButton';
import { LocalTab } from './local/LocalTab';
import { readLocalLibrary, groupLocal, localEntryToStoredEpisode } from '../services/local-library/local-library';
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

// Header component for Virtuoso (defined outside render to prevent remounting)
const HomeHeader: React.ComponentType<{ context?: HomeVirtuosoContext }> = ({ context }) => {
  if (!context) return null;
  const { featuredItems, type, onHeroPlay, onItemClick, tmdbApiKey, heroLoading, vodPlayerMode, onSelectVodPlayerMode } = context;
  
  if (featuredItems.length === 0 && !heroLoading) return null;
  
  return (
    <HeroSection
      items={featuredItems}
      type={type}
      onPlay={onHeroPlay}
      onMoreInfo={onItemClick}
      loading={heroLoading}
      vodPlayerMode={vodPlayerMode}
      onSelectVodPlayerMode={onSelectVodPlayerMode}
    />
  );
};

// Item renderer for Virtuoso (defined outside render)
// All data is pre-fetched, so this just renders the carousel
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

// Stable components object for Virtuoso
const homeVirtuosoComponents = {
  Header: HomeHeader,
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

  // Context Menu & Management State (local, not persisted)
  const [contextMenu, setContextMenu] = useState<{ sourceId: string; sourceName: string; x: number; y: number } | null>(null);
  const [manageCategoriesSource, setManageCategoriesSource] = useState<{ id: string; name: string } | null>(null);

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

  // Use appropriate store values based on type
  const selectedCategoryId = type === 'movie' ? moviesCategory : seriesCategory;
  const setSelectedCategoryId = type === 'movie' ? setMoviesCategory : setSeriesCategory;
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
  const recentlyWatchedItems = type === 'movie' 
    ? recentlyWatchedMoviesData.map(m => m.item)
    : recentlyWatchedSeriesData.map(s => s.item);
  const recentlyWatchedLoading = type === 'movie' ? recentlyWatchedMoviesLoading : recentlyWatchedSeriesLoading;
  
  // Create progress map for Recently Watched items
  const recentlyWatchedProgressMap = type === 'movie'
    ? new Map(recentlyWatchedMoviesData.map(m => [m.item.stream_id, m.progress_percent]))
    : new Map(recentlyWatchedSeriesData.map(s => [s.item.series_id, s.progress_percent]));

  // Create episode data map for Recently Watched series
  const recentlyWatchedEpisodeData = type === 'series'
    ? new Map(recentlyWatchedSeriesData.map(s => [s.item.series_id, { 
        seasonNum: s.season_num, 
        episodeNum: s.episode_num, 
        episodeTitle: s.episode_title 
      }]))
    : undefined;

  // Favorites - from Zustand persist store
  const enabledSourceIds = useEnabledSources();
  const allFavorites = useVodFavoritesStore((s) => s.favorites);
  const favoritesList = useMemo(
    () => allFavorites.filter(f => f.type === type),
    [allFavorites, type]
  );


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
        const dbInstance = await (db as any).dbPromise;
        const ids = favoritesList.map(f => f.id);
        const placeholders = ids.map(() => '?').join(',');

        if (type === 'movie') {
          const items: StoredMovie[] = await dbInstance.select(
            `SELECT * FROM vodMovies WHERE stream_id IN (${placeholders})`,
            ids
          );
          if (!cancelled) {
            const filteredItems = enabledSourceIds
              ? items.filter(item => enabledSourceIds.has(item.source_id))
              : items;
            const orderMap = new Map(ids.map((id, i) => [id, i]));
            filteredItems.sort((a, b) => (orderMap.get(a.stream_id) ?? 0) - (orderMap.get(b.stream_id) ?? 0));
            setFavoriteItems(filteredItems);
          }
        } else {
          const items: StoredSeries[] = await dbInstance.select(
            `SELECT * FROM vodSeries WHERE series_id IN (${placeholders})`,
            ids
          );
          if (!cancelled) {
            const filteredItems = enabledSourceIds
              ? items.filter(item => enabledSourceIds.has(item.source_id))
              : items;
            const orderMap = new Map(ids.map((id, i) => [id, i]));
            filteredItems.sort((a, b) => (orderMap.get(a.series_id) ?? 0) - (orderMap.get(b.series_id) ?? 0));
            setFavoriteItems(filteredItems);
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
  }, [selectedCategoryId, favoritesList, type, enabledSourceIds]);

  // VOD categories
  const { categories } = useVodCategories(type);

  const handlePlayPlaylistItem = useCallback((item: PlaylistItem, playlist: Playlist, isShuffle?: boolean) => {
    // Skip items whose source was removed/disabled so the queue never tries to
    // play an unavailable stream. Keeps the played item's own queue position.
    const queueItems = enabledSourceIds
      ? playlist.items.filter((i) => !isPlaylistItemHidden(i, enabledSourceIds))
      : playlist.items;
    useActivePlaylistStore.getState().startPlayback(
      playlist.id,
      playlist.name,
      queueItems,
      queueItems.findIndex(i => i.id === item.id),
      isShuffle
    );

    // Record the watch (Recent rail + episode progress) like normal VOD
    // playback does, so playlist plays show up and resume properly.
    void recordPlaylistItemWatch(item);
    onPlay?.(playlistItemToVodInfo(item), vodPlayerMode);
  }, [onPlay, vodPlayerMode]);

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
            (g) => g.kind === 'show' && g.key.toLowerCase() === targetKey
          );
          if (matchingGroup && matchingGroup.kind === 'show') {
            episodes = matchingGroup.episodes.map((ep) =>
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
          'SELECT * FROM episode_history WHERE series_id = ?',
          [series.series_id]
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
        const resumePosition = progress && (progress.progress_seconds ?? 0) > 10 ? (progress.progress_seconds ?? 0) : 0;
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
          backdropUrl: series.backdrop_path || undefined,
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

  return (
    <div className="vod-page">
      {/* Sidebar: Categories + Search + Back */}
      <VerticalSidebar
        categories={categories.map(c => ({ id: c.category_id, name: c.name, source_id: c.source_id }))}
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
      />

      {/* Main content */}
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
          // Home view: Hero + virtualized carousels
          <Virtuoso
            className="vod-page__home"
            data={carouselRows}
            context={homeVirtuosoContext}
            overscan={200}
            computeItemKey={(_, row) => row.key}
            components={homeVirtuosoComponents}
            itemContent={CarouselRowContent}
          />
        )}
      </main>

      {/* Detail modal */}
      {selectedItem && type === 'movie' && (
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
      {selectedItem && type === 'series' && (
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
        />
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
