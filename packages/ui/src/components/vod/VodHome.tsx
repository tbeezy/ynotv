/**
 * VodHome - Netflix-style home view with hero and carousels
 *
 * Shows TMDB-curated content rows matched against local Xtream content.
 */

import { useCallback, useEffect } from 'react';
import { HeroSection } from './HeroSection';
import { HorizontalCarousel } from './HorizontalCarousel';
import type { StoredMovie, StoredSeries } from '../../db';
import {
  useTmdbApiKey,
  useFeaturedContent,
  useTrendingMovies,
  usePopularMovies,
  useTopRatedMovies,
  useTrendingSeries,
  usePopularSeries,
  useTopRatedSeries,
  useMoviesByGenre,
  useSeriesByGenre,
  useMovieGenres,
  useTvGenres,
} from '../../hooks/useTmdbLists';
import { useRecentMovies, useRecentSeries, useRecentlyWatchedMovies, useRecentlyWatchedSeries } from '../../hooks/useVod';
import './VodHome.css';

// TMDB genre IDs
const GENRE_ACTION = 28;
const GENRE_COMEDY = 35;
const GENRE_ACTION_TV = 10759; // Action & Adventure for TV
const GENRE_COMEDY_TV = 35;

export interface VodHomeProps {
  type: 'movies' | 'series';
  onItemClick: (item: StoredMovie | StoredSeries) => void;
  onPlay: (item: StoredMovie | StoredSeries) => void;
}

export function VodHome({ type, onItemClick, onPlay }: VodHomeProps) {
  console.log('[VodHome] Rendering with type:', type);
  const tmdbApiKey = useTmdbApiKey();

  // Featured content for hero
  const { items: featuredItems } = useFeaturedContent(tmdbApiKey, type, 5);

  // Movie hooks
  const { movies: trendingMovies, loading: trendingMoviesLoading } = useTrendingMovies(tmdbApiKey);
  const { movies: popularMovies, loading: popularMoviesLoading } = usePopularMovies(tmdbApiKey);
  const { movies: topRatedMovies, loading: topRatedMoviesLoading } = useTopRatedMovies(tmdbApiKey);
  const { movies: actionMovies, loading: actionMoviesLoading } = useMoviesByGenre(tmdbApiKey, GENRE_ACTION);
  const { movies: comedyMovies, loading: comedyMoviesLoading } = useMoviesByGenre(tmdbApiKey, GENRE_COMEDY);
  const { movies: recentMovies, loading: recentMoviesLoading } = useRecentMovies(20);

  // Series hooks
  const { series: trendingSeries, loading: trendingSeriesLoading } = useTrendingSeries(tmdbApiKey);
  const { series: popularSeries, loading: popularSeriesLoading } = usePopularSeries(tmdbApiKey);
  const { series: topRatedSeries, loading: topRatedSeriesLoading } = useTopRatedSeries(tmdbApiKey);
  const { series: actionSeries, loading: actionSeriesLoading } = useSeriesByGenre(tmdbApiKey, GENRE_ACTION_TV);
  const { series: comedySeries, loading: comedySeriesLoading } = useSeriesByGenre(tmdbApiKey, GENRE_COMEDY_TV);
  const { series: recentSeries, loading: recentSeriesLoading } = useRecentSeries(20);

  // Recently watched (user viewing history) - shown at top
  const { movies: recentlyWatchedMoviesData, loading: recentlyWatchedMoviesLoading } = useRecentlyWatchedMovies(20);
  const { series: recentlyWatchedSeriesData, loading: recentlyWatchedSeriesLoading } = useRecentlyWatchedSeries(20);
  
  // Extract items and create progress maps
  const recentlyWatchedMovies = recentlyWatchedMoviesData.map(m => m.item);
  const recentlyWatchedSeries = recentlyWatchedSeriesData.map(s => s.item);
  
  // Debug logging for Recently Watched
  useEffect(() => {
    console.log('[VodHome] Movies data:', recentlyWatchedMoviesData.length, 'items, loading:', recentlyWatchedMoviesLoading);
    console.log('[VodHome] Series data:', recentlyWatchedSeriesData.length, 'items, loading:', recentlyWatchedSeriesLoading);
    console.log('[VodHome] Movies extracted:', recentlyWatchedMovies.length);
    console.log('[VodHome] Series extracted:', recentlyWatchedSeries.length);
  }, [recentlyWatchedMoviesData, recentlyWatchedSeriesData, recentlyWatchedMoviesLoading, recentlyWatchedSeriesLoading, recentlyWatchedMovies.length, recentlyWatchedSeries.length]);
  
  // Create progress maps for Recently Watched carousels
  const movieProgressMap = new Map(recentlyWatchedMoviesData.map(m => [m.item.stream_id, m.progress_percent]));
  const seriesProgressMap = new Map(recentlyWatchedSeriesData.map(s => [s.item.series_id, s.progress_percent]));

  const handleHeroPlay = useCallback((item: StoredMovie | StoredSeries) => {
    onPlay(item);
  }, [onPlay]);

  const handleHeroMoreInfo = useCallback((item: StoredMovie | StoredSeries) => {
    onItemClick(item);
  }, [onItemClick]);

  if (type === 'movies') {
    return (
      <div className="vod-home">
        <HeroSection
          items={featuredItems as StoredMovie[]}
          type="movie"
          onPlay={handleHeroPlay}
          onMoreInfo={handleHeroMoreInfo}
          autoRotate
          rotateInterval={8000}
        />

        <div className="vod-home__carousels">
          {recentlyWatchedMovies.length > 0 && (
            <HorizontalCarousel
              title="Recently Watched"
              items={recentlyWatchedMovies}
              type="movie"
              onItemClick={onItemClick}
              loading={recentlyWatchedMoviesLoading}
              maxItems={20}
              progressData={movieProgressMap}
            />
          )}

          <HorizontalCarousel
            title="Trending This Week"
            items={trendingMovies}
            type="movie"
            onItemClick={onItemClick}
            loading={trendingMoviesLoading}
            maxItems={20}
          />

          <HorizontalCarousel
            title="Popular"
            items={popularMovies}
            type="movie"
            onItemClick={onItemClick}
            loading={popularMoviesLoading}
            maxItems={20}
          />

          <HorizontalCarousel
            title="Top Rated"
            items={topRatedMovies}
            type="movie"
            onItemClick={onItemClick}
            loading={topRatedMoviesLoading}
            maxItems={20}
          />

          <HorizontalCarousel
            title="Action"
            items={actionMovies}
            type="movie"
            onItemClick={onItemClick}
            loading={actionMoviesLoading}
            maxItems={20}
          />

          <HorizontalCarousel
            title="Comedy"
            items={comedyMovies}
            type="movie"
            onItemClick={onItemClick}
            loading={comedyMoviesLoading}
            maxItems={20}
          />

          <HorizontalCarousel
            title="Recently Added"
            items={recentMovies}
            type="movie"
            onItemClick={onItemClick}
            loading={recentMoviesLoading}
            maxItems={20}
          />
        </div>
      </div>
    );
  }

  // Series view
  return (
    <div className="vod-home">
      <HeroSection
        items={featuredItems as StoredSeries[]}
        type="series"
        onPlay={handleHeroPlay}
        onMoreInfo={handleHeroMoreInfo}
        autoRotate
        rotateInterval={8000}
      />

      <div className="vod-home__carousels">
        {recentlyWatchedSeries.length > 0 && (
          <HorizontalCarousel
            title="Recently Watched"
            items={recentlyWatchedSeries}
            type="series"
            onItemClick={onItemClick}
            loading={recentlyWatchedSeriesLoading}
            maxItems={20}
            progressData={seriesProgressMap}
          />
        )}

        <HorizontalCarousel
          title="Trending This Week"
          items={trendingSeries}
          type="series"
          onItemClick={onItemClick}
          loading={trendingSeriesLoading}
          maxItems={20}
        />

        <HorizontalCarousel
          title="Popular"
          items={popularSeries}
          type="series"
          onItemClick={onItemClick}
          loading={popularSeriesLoading}
          maxItems={20}
        />

        <HorizontalCarousel
          title="Top Rated"
          items={topRatedSeries}
          type="series"
          onItemClick={onItemClick}
          loading={topRatedSeriesLoading}
          maxItems={20}
        />

        <HorizontalCarousel
          title="Action & Adventure"
          items={actionSeries}
          type="series"
          onItemClick={onItemClick}
          loading={actionSeriesLoading}
          maxItems={20}
        />

        <HorizontalCarousel
          title="Comedy"
          items={comedySeries}
          type="series"
          onItemClick={onItemClick}
          loading={comedySeriesLoading}
          maxItems={20}
        />

        <HorizontalCarousel
          title="Recently Added"
          items={recentSeries}
          type="series"
          onItemClick={onItemClick}
          loading={recentSeriesLoading}
          maxItems={20}
        />
      </div>
    </div>
  );
}

export default VodHome;
