import { useState, useCallback, useEffect, useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { HeroSection } from './vod/HeroSection';
import { HorizontalCarousel } from './vod/HorizontalCarousel';
import { VerticalSidebar } from './vod/VerticalSidebar';
import { VodBrowse } from './vod/VodBrowse';
import { MovieDetail } from './vod/MovieDetail';
import { SeriesDetail } from './vod/SeriesDetail';
import { useVodCategories } from '../hooks/useVod';
import {
  useTrendingMovies,
  usePopularMovies,
  useTopRatedMovies,
  useNowPlayingMovies,
  useLocalPopularMovies,
  useTrendingSeries,
  usePopularSeries,
  useTopRatedSeries,
  useOnTheAirSeries,
  useLocalPopularSeries,
  useFeaturedContent,
  useTmdbApiKey,
  useMovieGenres,
  useTvGenres,
  useEnabledMovieGenres,
  useEnabledSeriesGenres,
  useMultipleMoviesByGenre,
  useMultipleSeriesByGenre,
} from '../hooks/useTmdbLists';
import {
  useMoviesCategory,
  useSetMoviesCategory,
  useSeriesCategory,
  useSetSeriesCategory,
} from '../stores/uiStore';
import type { StoredMovie, StoredSeries } from '../db';
import { type MediaItem, type VodType, type VodPlayInfo } from '../types/media';
import './VodPage.css';

// Carousel row type for virtualization (all data pre-fetched)
type CarouselRow = {
  key: string;
  title: string;
  items: MediaItem[];
  loading?: boolean;
};

// Context passed to Virtuoso components (must be defined outside render)
interface HomeVirtuosoContext {
  type: VodType;
  tmdbApiKey: string | null;
  featuredItems: MediaItem[];
  localPopularItems: MediaItem[];
  heroLoading: boolean;
  onItemClick: (item: MediaItem) => void;
  onHeroPlay: (item: MediaItem) => void;
}

// Header component for Virtuoso (defined outside render to prevent remounting)
const HomeHeader: React.ComponentType<{ context?: HomeVirtuosoContext }> = ({ context }) => {
  if (!context) return null;
  const { featuredItems, localPopularItems, type, onHeroPlay, onItemClick, tmdbApiKey, heroLoading } = context;
  return (
    <HeroSection
      items={featuredItems.length > 0 ? featuredItems : localPopularItems.slice(0, 5)}
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
  const { type, onItemClick } = context;

  return (
    <HorizontalCarousel
      title={row.title}
      items={row.items}
      type={type}
      onItemClick={onItemClick}
      loading={row.loading}
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
  const [searchQuery, setSearchQuery] = useState('');

  // Category state - use the appropriate store based on type
  const moviesCategory = useMoviesCategory();
  const setMoviesCategory = useSetMoviesCategory();
  const seriesCategory = useSeriesCategory();
  const setSeriesCategory = useSetSeriesCategory();

  const selectedCategoryId = type === 'movie' ? moviesCategory : seriesCategory;
  const setSelectedCategoryId = type === 'movie' ? setMoviesCategory : setSeriesCategory;

  // API key for TMDB
  const tmdbApiKey = useTmdbApiKey();

  // Genres from TMDB
  const { genres: movieGenres } = useMovieGenres(type === 'movie' ? tmdbApiKey : null);
  const { genres: tvGenres } = useTvGenres(type === 'series' ? tmdbApiKey : null);
  const genres = type === 'movie' ? movieGenres : tvGenres;

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

  // Fallback: local popularity
  const { movies: localPopularMovies } = useLocalPopularMovies(type === 'movie' ? 20 : 0);
  const { series: localPopularSeries } = useLocalPopularSeries(type === 'series' ? 20 : 0);
  const localPopularItems = type === 'movie' ? localPopularMovies : localPopularSeries;

  // VOD categories
  const { categories } = useVodCategories(type);

  // Get selected category name for VodBrowse
  const selectedCategory = categories.find(c => c.category_id === selectedCategoryId);

  // Enabled genres from settings
  const enabledMovieGenres = useEnabledMovieGenres();
  const enabledSeriesGenres = useEnabledSeriesGenres();
  const enabledGenreIds = type === 'movie' ? enabledMovieGenres : enabledSeriesGenres;

  // Filter genres to only show enabled ones
  // No hard limit - user controls via Settings which genres to show
  const genresToShow = useMemo(() => {
    if (!genres.length) return [];
    // If no enabled genres defined yet (undefined), show all genres
    if (enabledGenreIds === undefined) {
      return genres;
    }
    // Show all enabled genres (user chose these in Settings)
    return genres.filter(g => enabledGenreIds.includes(g.id));
  }, [genres, enabledGenreIds]);

  // Get genre IDs for pre-fetching
  const genreIdsToFetch = useMemo(
    () => genresToShow.map(g => g.id),
    [genresToShow]
  );

  // Pre-fetch all genre data at once (not lazily per-carousel)
  // This ensures smooth scrolling - data is ready before carousels render
  const movieGenreData = useMultipleMoviesByGenre(
    type === 'movie' ? tmdbApiKey : null,
    type === 'movie' ? genreIdsToFetch : []
  );
  const seriesGenreData = useMultipleSeriesByGenre(
    type === 'series' ? tmdbApiKey : null,
    type === 'series' ? genreIdsToFetch : []
  );
  const genreData = type === 'movie' ? movieGenreData : seriesGenreData;

  // Build carousel rows for virtualization
  // Only includes rows that have content (or are still loading)
  const carouselRows = useMemo((): CarouselRow[] => {
    const rows: CarouselRow[] = [];

    // Check if we have any TMDB-matched content (not just fetched)
    const hasMatchedTmdbContent = (trendingItems.length > 0 && !trendingLoading) || 
                                   (popularItems.length > 0 && !popularLoading) || 
                                   (topRatedItems.length > 0 && !topRatedLoading);

    // Trending - use local popular as fallback if no TMDB matches
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
    } else if (!hasMatchedTmdbContent && localPopularItems.length > 0) {
      // Fallback: show local popular content as "Trending" when no TMDB matches
      rows.push({
        key: 'trending-local',
        title: 'Trending Now',
        items: localPopularItems.slice(0, 20),
        loading: false,
      });
    }

    // Popular - use local popular as fallback if no TMDB matches
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
    } else if (!hasMatchedTmdbContent && localPopularItems.length > 0) {
      // Fallback: show local popular content
      rows.push({
        key: 'popular-local',
        title: 'Popular',
        items: localPopularItems.slice(0, 20),
        loading: false,
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

    // Genre carousels - use pre-fetched data (only if has content or still loading)
    for (const genre of genresToShow) {
      const data = genreData.get(genre.id);
      const items = data?.items || [];
      const loading = data?.loading ?? true;
      // Only add row if it has content or is still loading
      if (items.length > 0 || loading) {
        rows.push({
          key: `genre-${genre.id}`,
          title: genre.name,
          items,
          loading,
        });
      }
    }

    return rows;
  }, [
    trendingItems, trendingLoading,
    popularItems, popularLoading,
    topRatedItems, topRatedLoading,
    nowOrOnAirItems, nowOrOnAirLoading,
    genresToShow, genreData,
    type, localPopularItems,
  ]);

  const handleItemClick = useCallback((item: MediaItem) => {
    setSelectedItem(item);
  }, []);

  const handlePlay = useCallback((info: VodPlayInfo) => {
    if (onPlay) {
      onPlay(info);
    }
  }, [onPlay]);

  const handleCloseDetail = useCallback(() => {
    setSelectedItem(null);
  }, []);

  // Handle hero play button - movies play directly, series open detail
  const handleHeroPlay = useCallback((item: MediaItem) => {
    if (type === 'movie') {
      const movie = item as StoredMovie;
      handlePlay({
        url: movie.direct_url,
        title: movie.title || movie.name,
        year: movie.year || movie.release_date?.slice(0, 4),
        plot: movie.plot,
        type: 'movie',
        source_id: movie.source_id,
      });
    } else {
      setSelectedItem(item);
    }
  }, [type, handlePlay]);

  // Hero is loading if we have no items AND data is still being fetched
  const heroLoading = featuredItems.length === 0 &&
    localPopularItems.length === 0 &&
    (trendingLoading || popularLoading);

  // Memoized context for Virtuoso to prevent unnecessary re-renders
  const homeVirtuosoContext = useMemo((): HomeVirtuosoContext => ({
    type,
    tmdbApiKey,
    featuredItems,
    localPopularItems,
    heroLoading,
    onItemClick: handleItemClick,
    onHeroPlay: handleHeroPlay,
  }), [type, tmdbApiKey, featuredItems, localPopularItems, heroLoading, handleItemClick, handleHeroPlay]);

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
        categories={categories.map(c => ({ id: c.category_id, name: c.name }))}
        selectedId={selectedCategoryId}
        onSelect={handleCategorySelect}
        type={type}
        onBack={onClose}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSearchSubmit={() => {
          if (searchQuery.trim() && selectedCategoryId === null) {
            setSelectedCategoryId('all');
          }
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
          onPlay={(movie, plot) => handlePlay({
            url: movie.direct_url,
            title: movie.title || movie.name,
            year: movie.year || movie.release_date?.slice(0, 4),
            plot: plot || movie.plot,
            type: 'movie',
            source_id: movie.source_id,
          })}
          apiKey={tmdbApiKey}
        />
      )}
      {selectedItem && type === 'series' && (
        <SeriesDetail
          series={selectedItem as StoredSeries}
          onClose={handleCloseDetail}
          onPlayEpisode={handlePlay}
          apiKey={tmdbApiKey}
        />
      )}
    </div>
  );
}

export default VodPage;
