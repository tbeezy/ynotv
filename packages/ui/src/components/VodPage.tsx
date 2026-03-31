import { useState, useCallback, useEffect, useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { HeroSection } from './vod/HeroSection';
import { HorizontalCarousel } from './vod/HorizontalCarousel';
import { VerticalSidebar } from './vod/VerticalSidebar';
import { VodBrowse } from './vod/VodBrowse';
import { RecentView } from './vod/RecentView';
import { MovieDetail } from './vod/MovieDetail';
import { SeriesDetail } from './vod/SeriesDetail';
import { SourceContextMenu } from './SourceContextMenu';
import { ManageVodCategories } from './vod/ManageVodCategories';
import { useVodCategories, useRecentlyWatchedMovies, useRecentlyWatchedSeries } from '../hooks/useVod';
import {
  useTrendingMovies,
  usePopularMovies,
  useTopRatedMovies,
  useNowPlayingMovies,
  useTrendingSeries,
  usePopularSeries,
  useTopRatedSeries,
  useOnTheAirSeries,
  useFeaturedContent,
  useTmdbApiKey,
} from '../hooks/useTmdbLists';
import {
  useMoviesCategory,
  useSetMoviesCategory,
  useSeriesCategory,
  useSetSeriesCategory,
} from '../stores/uiStore';
import type { StoredMovie, StoredSeries } from '../db';
import { removeFromRecentlyWatched } from '../db';
import { recordVodWatch } from '../db';
import { type MediaItem, type VodType, type VodPlayInfo } from '../types/media';
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
  onHeroPlay: (item: MediaItem) => void;
  onRemoveFromRecentlyWatched?: (item: MediaItem) => void;
}

// Header component for Virtuoso (defined outside render to prevent remounting)
const HomeHeader: React.ComponentType<{ context?: HomeVirtuosoContext }> = ({ context }) => {
  if (!context) return null;
  const { featuredItems, type, onHeroPlay, onItemClick, tmdbApiKey, heroLoading } = context;
  
  if (featuredItems.length === 0 && !heroLoading) return null;
  
  return (
    <HeroSection
      items={featuredItems}
      type={type}
      onPlay={onHeroPlay}
      onMoreInfo={onItemClick}
      apiKey={tmdbApiKey}
      loading={heroLoading}
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
  const { type, onItemClick, onRemoveFromRecentlyWatched } = context;

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
    />
  );
};

// Stable components object for Virtuoso
const homeVirtuosoComponents = {
  Header: HomeHeader,
};

interface VodPageProps {
  type: VodType;
  onPlay?: (info: VodPlayInfo) => void;
  onClose?: () => void;
}

export function VodPage({ type, onPlay, onClose }: VodPageProps) {
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [selectedSeason, setSelectedSeason] = useState<number | undefined>(undefined); // For Recently Watched season navigation
  const [searchQuery, setSearchQuery] = useState('');
  
  // Context Menu & Management State
  const [contextMenu, setContextMenu] = useState<{ sourceId: string; sourceName: string; x: number; y: number } | null>(null);
  const [manageCategoriesSource, setManageCategoriesSource] = useState<{ id: string; name: string } | null>(null);

  // Category state - use the appropriate store based on type
  const moviesCategory = useMoviesCategory();
  const setMoviesCategory = useSetMoviesCategory();
  const seriesCategory = useSeriesCategory();
  const setSeriesCategory = useSetSeriesCategory();

  const selectedCategoryId = type === 'movie' ? moviesCategory : seriesCategory;
  const setSelectedCategoryId = type === 'movie' ? setMoviesCategory : setSeriesCategory;

  // API key for TMDB
  const tmdbApiKey = useTmdbApiKey();

  // Featured content for hero
  const { items: featuredItems } = useFeaturedContent(tmdbApiKey, type === 'movie' ? 'movies' : 'series', 5);

  // Trending and popular from TMDB (if API key available)
  const { movies: trendingMovies, loading: trendingMoviesLoading } = useTrendingMovies(type === 'movie' ? tmdbApiKey : null);
  const { series: trendingSeries, loading: trendingSeriesLoading } = useTrendingSeries(type === 'series' ? tmdbApiKey : null);
  const { movies: popularMovies, loading: popularMoviesLoading } = usePopularMovies(type === 'movie' ? tmdbApiKey : null);
  const { series: popularSeries, loading: popularSeriesLoading } = usePopularSeries(type === 'series' ? tmdbApiKey : null);

  // Top rated
  const { movies: topRatedMovies, loading: topRatedMoviesLoading } = useTopRatedMovies(type === 'movie' ? tmdbApiKey : null);
  const { series: topRatedSeries, loading: topRatedSeriesLoading } = useTopRatedSeries(type === 'series' ? tmdbApiKey : null);

  // Now playing (movies) / On the air (series)
  const { movies: nowPlayingMovies, loading: nowPlayingLoading } = useNowPlayingMovies(type === 'movie' ? tmdbApiKey : null);
  const { series: onTheAirSeries, loading: onTheAirLoading } = useOnTheAirSeries(type === 'series' ? tmdbApiKey : null);

  // Select the right data based on type
  const trendingItems = type === 'movie' ? trendingMovies : trendingSeries;
  const trendingLoading = type === 'movie' ? trendingMoviesLoading : trendingSeriesLoading;
  const popularItems = type === 'movie' ? popularMovies : popularSeries;
  const popularLoading = type === 'movie' ? popularMoviesLoading : popularSeriesLoading;
  const topRatedItems = type === 'movie' ? topRatedMovies : topRatedSeries;
  const topRatedLoading = type === 'movie' ? topRatedMoviesLoading : topRatedSeriesLoading;
  const nowOrOnAirItems = type === 'movie' ? nowPlayingMovies : onTheAirSeries;
  const nowOrOnAirLoading = type === 'movie' ? nowPlayingLoading : onTheAirLoading;

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

  // VOD categories
  const { categories } = useVodCategories(type);

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
        title: 'Recently Watched',
        items: recentlyWatchedItems,
        loading: false,
        progressData: recentlyWatchedProgressMap,
        isRecentlyWatched: true,
        episodeData: recentlyWatchedEpisodeData,
      });
    } else if (recentlyWatchedLoading) {
      rows.push({
        key: 'recently-watched',
        title: 'Recently Watched',
        items: [],
        loading: true,
      });
    }

    // Check if we have any TMDB-matched content (not just fetched)
    const hasMatchedTmdbContent = (trendingItems.length > 0 && !trendingLoading) || 
                                   (popularItems.length > 0 && !popularLoading) || 
                                   (topRatedItems.length > 0 && !topRatedLoading);

    // Trending
    if (trendingItems.length > 0) {
      rows.push({
        key: 'trending',
        title: 'Trending Now',
        items: trendingItems,
        loading: false,
      });
    } else if (trendingLoading) {
      rows.push({
        key: 'trending',
        title: 'Trending Now',
        items: [],
        loading: true,
      });
    }

    // Popular
    if (popularItems.length > 0) {
      rows.push({
        key: 'popular',
        title: 'Popular',
        items: popularItems,
        loading: false,
      });
    } else if (popularLoading) {
      rows.push({
        key: 'popular',
        title: 'Popular',
        items: [],
        loading: true,
      });
    }

    // Top Rated
    if (topRatedItems.length > 0 || topRatedLoading) {
      rows.push({
        key: 'top-rated',
        title: 'Top Rated',
        items: topRatedItems,
        loading: topRatedLoading,
      });
    }

    // Now Playing / On The Air
    if (nowOrOnAirItems.length > 0 || nowOrOnAirLoading) {
      rows.push({
        key: 'now-or-onair',
        title: type === 'movie' ? 'Now Playing' : 'On The Air',
        items: nowOrOnAirItems,
        loading: nowOrOnAirLoading,
      });
    }

    return rows;
  }, [
    recentlyWatchedItems, recentlyWatchedLoading, recentlyWatchedProgressMap,
    trendingItems, trendingLoading,
    popularItems, popularLoading,
    topRatedItems, topRatedLoading,
    nowOrOnAirItems, nowOrOnAirLoading,
    type,
  ]);

  const handleItemClick = useCallback((item: MediaItem) => {
    if (item.source_id === 'tmdb') {
      const title = item.title || item.name || '';
      if (title) {
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
  }, [type, recentlyWatchedEpisodeData]);

  // Handle clicks from Recent view (includes season/episode info for series)
  const handleRecentItemClick = useCallback((item: MediaItem, seasonNum?: number, episodeNum?: number, episodeTitle?: string) => {
    if (item.source_id === 'tmdb') {
      const title = item.title || item.name || '';
      if (title) {
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
  }, [type]);

  const handlePlay = useCallback((info: VodPlayInfo) => {
    if (onPlay) {
      onPlay(info);
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
  const handleHeroPlay = useCallback((item: MediaItem) => {
    if (item.source_id === 'tmdb') {
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
      });
    } else {
      setSelectedItem(item);
    }
  }, [type, handlePlay]);

  // Hero is loading if we have no items AND data is still being fetched
  const heroLoading = featuredItems.length === 0 &&
    (trendingLoading || popularLoading);

  // Memoized context for Virtuoso to prevent unnecessary re-renders
  const homeVirtuosoContext = useMemo((): HomeVirtuosoContext => ({
    type,
    tmdbApiKey,
    featuredItems,
    heroLoading,
    onItemClick: handleItemClick,
    onHeroPlay: handleHeroPlay,
    onRemoveFromRecentlyWatched: handleRemoveFromRecentlyWatched,
  }), [type, tmdbApiKey, featuredItems, heroLoading, handleItemClick, handleHeroPlay, handleRemoveFromRecentlyWatched]);

  // Handle category selection - also close detail view
  const handleCategorySelect = useCallback((id: string | null) => {
    setSelectedCategoryId(id);
    setSelectedItem(null);
  }, [setSelectedCategoryId]);

  // Handle mouse back button and browser back - close detail view
  useEffect(() => {
    const handleMouseBack = (e: MouseEvent) => {
      if (e.button === 3 && selectedItem) {
        e.preventDefault();
        setSelectedItem(null);
      }
    };

    const handlePopState = () => {
      if (selectedItem) {
        setSelectedItem(null);
      }
    };

    window.addEventListener('mousedown', handleMouseBack);
    window.addEventListener('popstate', handlePopState);

    // Push state when opening detail so back button works
    if (selectedItem) {
      window.history.pushState({ vodDetail: true }, '');
    }

    return () => {
      window.removeEventListener('mousedown', handleMouseBack);
      window.removeEventListener('popstate', handlePopState);
    };
  }, [selectedItem]);

  // Labels
  const typeLabel = type === 'movie' ? 'Movies' : 'Series';
  const browseType = type === 'movie' ? 'movies' : 'series';

  return (
    <div className="vod-page">
      {/* Sidebar: Categories + Search + Back */}
      <VerticalSidebar
        categories={categories.map(c => ({ id: c.category_id, name: c.name, source_id: c.source_id }))}
        selectedId={selectedCategoryId}
        onSelect={handleCategorySelect}
        type={type}
        onBack={onClose}
        searchQuery={searchQuery}
        onSearchChange={(query) => {
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
        {selectedCategoryId === 'all' ? (
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
            fixedItemHeight={386}
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
          onPlay={(movie, plot) => {
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
            });
          }}
          apiKey={tmdbApiKey}
        />
      )}
      {selectedItem && type === 'series' && (
        <SeriesDetail
          series={selectedItem as StoredSeries}
          onClose={handleCloseDetail}
          onPlayEpisode={handlePlay}
          apiKey={tmdbApiKey}
          initialSeason={selectedSeason}
        />
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
