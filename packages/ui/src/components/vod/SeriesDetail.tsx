/**
 * SeriesDetail - Full page series detail view with season/episode picker
 *
 * Shows series information with backdrop, metadata, season button row,
 * and episode cards with images, summaries, air dates, and ratings.
 * Slides in as a full page, not a modal.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getTmdbImageUrl, TMDB_POSTER_SIZES, tmdbPersonIdByName } from '../../services/tmdb';
import { useLazyBackdrop } from '../../hooks/useLazyBackdrop';
import { useLazyPlot } from '../../hooks/useLazyPlot';
import { useLazyCredits } from '../../hooks/useLazyCredits';
import { useLazySeriesExtras } from '../../hooks/useLazySeriesExtras';
import { useSeriesDetails, useSeriesEpisodeProgress } from '../../hooks/useVod';
import { useLiveQuery } from '../../hooks/useSqliteLiveQuery';
import { useRpdbSettings } from '../../hooks/useRpdbSettings';
import { getRpdbPosterUrl } from '../../services/rpdb';
import type { StoredSeries, StoredEpisode } from '../../db';
import { db, recordVodWatch, recordEpisodeWatch, setVodEpisodeWatchedState } from '../../db';
import type { VodPlayInfo } from '../../types/media';
import { resolvePlayUrl } from '../../services/stream-resolver';
import { useDownloadStore } from '../../stores/downloadStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVodFavoritesStore } from '../../stores/vodFavoritesStore';
import { useActiveTmdbToken } from '../../hooks/useTmdbLists';
import { useLazyVodTrailer, useTrailerPlayerMode, useTrailerSource } from '../../hooks/useLazyVodTrailer';
import { SetPlayerDropdown, SplitPlayButton, TrailerSplitButton, type VodPlayerMode } from './SplitPlayButton';
import { AddToPlaylistModal } from './AddToPlaylistModal';
import { VodMetadataEditModal } from './VodMetadataEditModal';
import { useSourceNameMap } from '../../hooks/useChannels';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../../utils/dateTime';
import i18n from '../../i18n';
import {
  useVodMetadataOverridesStore,
  overrideKey,
  applyVodMetadataOverride,
} from '../../stores/vodMetadataOverridesStore';
import './SeriesDetail.css';

export interface SeriesDetailProps {
  series: StoredSeries;
  onClose: () => void;
  onPlayEpisode?: (info: VodPlayInfo, targetMode?: VodPlayerMode) => void;
  apiKey?: string | null; // TMDB API key for lazy backdrop loading
  initialSeason?: number; // Initial season to show (for Recently Watched navigation)
  onCastClick?: (personId: number) => void;
  vodPlayerMode?: VodPlayerMode;
  onSelectVodPlayerMode?: (mode: VodPlayerMode) => void;
}

export function SeriesDetail({ series: seriesProp, onClose, onPlayEpisode, apiKey, initialSeason, onCastClick, vodPlayerMode, onSelectVodPlayerMode }: SeriesDetailProps) {
  useTranslation();
  const sourceNameMap = useSourceNameMap();
  // Read the latest series row from the DB so that enrichment written after
  // episode sync (e.g. tmdb_id backfilled from get_series_info) propagates to
  // the lazy metadata hooks, which re-run when series?.tmdb_id changes.
  const liveSeries = useLiveQuery(async () => {
    return db.vodSeries.get(seriesProp.series_id);
  }, [seriesProp.series_id], undefined, 0, 'vodSeries');
  const baseSeries = liveSeries ?? seriesProp;

  // Merge user-corrected metadata (title/year/poster/plot/tmdb_id) on top of
  // the provider row. The override table is never touched by sync, so edits
  // survive provider refreshes. Everything below uses the merged series.
  const metadataOverride = useVodMetadataOverridesStore((s) => s.overrides[overrideKey(baseSeries.series_id, 'series')]);
  const series = useMemo(() => applyVodMetadataOverride(baseSeries, metadataOverride), [baseSeries, metadataOverride]);

  const [selectedSeason, setSelectedSeason] = useState<number>(initialSeason ?? 1);
  const [isPlaylistModalOpen, setIsPlaylistModalOpen] = useState(false);
  const [isMetadataEditOpen, setIsMetadataEditOpen] = useState(false);
  const [preselectedEpisode, setPreselectedEpisode] = useState<StoredEpisode | null>(null);

  // Fetch episodes
  const { seasons, loading, error, refetch } = useSeriesDetails(series.series_id);

  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const startDownload = useDownloadStore((s) => s.startDownload);

  const isFav = useVodFavoritesStore((s) => s.isFavorite(series.series_id, 'series'));
  const addFavorite = useVodFavoritesStore((s) => s.addFavorite);
  const removeFavorite = useVodFavoritesStore((s) => s.removeFavorite);
  const handleToggleFavorite = useCallback(() => {
    if (isFav) {
      removeFavorite(series.series_id, 'series');
    } else {
      addFavorite({
        id: series.series_id,
        type: 'series',
        title: series.title || series.name,
        poster: series.cover,
        year: series.year || series.release_date?.slice(0, 4),
      });
    }
  }, [isFav, series, addFavorite, removeFavorite]);

  // Load RPDB settings for poster
  const { apiKey: rpdbApiKey } = useRpdbSettings();
  const rpdbPosterUrl = rpdbApiKey && series.tmdb_id
    ? getRpdbPosterUrl(rpdbApiKey, series.tmdb_id, 'series')
    : null;

  // Priority: RPDB poster > local cover > TMDB/TVMaze fallback
  const posterUrl = rpdbPosterUrl || series.cover ||
    (series.backdrop_path
      ? series.backdrop_path.startsWith('http')
        ? series.backdrop_path  // TVMaze full URL
        : getTmdbImageUrl(series.backdrop_path, TMDB_POSTER_SIZES.medium)  // TMDB path
      : null);

  const handleDownloadEpisode = useCallback(
    async (episode: StoredEpisode, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!episode.direct_url) return;
      setDownloadingId(episode.id);
      try {
        const resolved = await resolvePlayUrl(series.source_id, episode.direct_url);
        
        let episodeDuration = episode.duration ?? 0;
        if (!episodeDuration && episode.info?.duration) {
          const parsedDuration = Number(episode.info.duration);
          episodeDuration = isNaN(parsedDuration) ? 0 : parsedDuration;
        }

        const epTitle = `${series.title || series.name} - S${episode.season_num}E${episode.episode_num}`;

        await startDownload(
          epTitle,
          resolved.url,
          resolved.userAgent,
          episodeDuration ? episodeDuration * 60 : undefined,
          undefined,
          posterUrl || undefined,
          series.source_id,
          episode.direct_url
        );
      } catch (error) {
        console.error('[SeriesDetail] Episode download failed:', error);
        alert(i18n.t('vod:failedStartDownload'));
      } finally {
        setDownloadingId(null);
      }
    },
    [series, startDownload, posterUrl]
  );
  const [downloadingSeason, setDownloadingSeason] = useState(false);

  const handleDownloadSeason = useCallback(async () => {
    const episodes = seasons[selectedSeason] || [];
    if (episodes.length === 0) return;

    setDownloadingSeason(true);
    try {
      // 1. Resolve downloads path (from the settings store — hydrated at boot)
      const downloadsPath = useSettingsStore.getState().downloadsPath;

      let targetDir = downloadsPath;
      if (!targetDir) {
        // Prompt user ONCE to pick a directory for the season downloads
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          directory: true,
          multiple: false,
          title: i18n.t('vod:selectDirectorySeason', { season: selectedSeason }),
        });
        if (!selected || typeof selected !== 'string') {
          // User canceled picker
          setDownloadingSeason(false);
          return;
        }
        targetDir = selected;
      }

      // 2. Queue all episodes
      const separator = targetDir.includes('\\') ? '\\' : '/';
      
      for (const episode of episodes) {
        if (!episode.direct_url) continue;

        try {
          const resolved = await resolvePlayUrl(series.source_id, episode.direct_url);
          
          let episodeDuration = episode.duration ?? 0;
          if (!episodeDuration && episode.info?.duration) {
            const parsedDuration = Number(episode.info.duration);
            episodeDuration = isNaN(parsedDuration) ? 0 : parsedDuration;
          }

          const epTitle = `${series.title || series.name} - S${episode.season_num}E${episode.episode_num}`;
          const isHls = resolved.url.includes('.m3u8') || resolved.url.includes('/mono.m3u8');
          const ext = isHls ? 'ts' : 'mp4';
          const sanitizedTitle = epTitle.replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);
          const episodeSavePath = `${targetDir}${targetDir.endsWith(separator) ? '' : separator}${sanitizedTitle}.${ext}`;

          await startDownload(
            epTitle,
            resolved.url,
            resolved.userAgent,
            episodeDuration ? episodeDuration * 60 : undefined,
            episodeSavePath,
            posterUrl || undefined,
            series.source_id,
            episode.direct_url
          );
        } catch (err) {
          console.error(`[SeriesDetail] Failed to queue episode S${episode.season_num}E${episode.episode_num}:`, err);
        }
      }
    } catch (error) {
      console.error('[SeriesDetail] Season download failed:', error);
      alert(i18n.t('vod:failedToStartSeasonDownload'));
    } finally {
      setDownloadingSeason(false);
    }
  }, [series, selectedSeason, seasons, startDownload, posterUrl]);

  // Fetch episode progress
  const { episodeProgress, loading: progressLoading } = useSeriesEpisodeProgress(series.series_id);

  // Fetch episode extras (images, summaries, air dates, ratings) and series logo
  const { logoUrl, episodeExtras, loading: extrasLoading } = useLazySeriesExtras(series, apiKey);

  // Get sorted season numbers
  const seasonNumbers = Object.keys(seasons)
    .map(Number)
    .sort((a, b) => a - b);

  // Set first season as default when loaded
  useEffect(() => {
    if (seasonNumbers.length > 0 && !seasonNumbers.includes(selectedSeason)) {
      setSelectedSeason(seasonNumbers[0]);
    }
  }, [seasonNumbers, selectedSeason]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Lazy-load backdrop, plot, genre, rating, and credits from TMDB/TVMaze if available
  const tmdbBackdropUrl = useLazyBackdrop(series, apiKey);
  const { plot: lazyPlot, genre: lazyGenre, rating: lazyRating } = useLazyPlot(series, apiKey);
  const lazyCredits = useLazyCredits(series, apiKey);

  // Get images - use TMDB backdrop if available, fallback to cover
  const backdropUrl = tmdbBackdropUrl || series.cover;

  const handleCastNameClick = useCallback(async (name: string) => {
    if (!apiKey) return;
    try {
      const personId = await tmdbPersonIdByName(apiKey, name);
      if (personId) {
        if (onCastClick) {
          onCastClick(personId);
        } else {
          window.dispatchEvent(new CustomEvent('ynotv:navigate-to-person', {
            detail: { personId }
          }));
        }
      }
    } catch (e) {
      console.error('Failed to lookup cast member ID:', e);
    }
  }, [apiKey, onCastClick]);

  const handlePlayEpisode = useCallback(
    (episode: StoredEpisode, targetMode?: VodPlayerMode) => {
      // Get current progress for this episode
      const progress = episodeProgress.get(episode.id);
      console.log('[SeriesDetail] Episode progress lookup:', episode.id, progress);
      const resumePosition = progress && progress.progressSeconds > 10 ? progress.progressSeconds : 0;
      console.log('[SeriesDetail] Resume position:', resumePosition);

      // Record series watch for Recently Watched with episode info
      void recordVodWatch(
        series.series_id,
        'series',
        series.source_id,
        series.title || series.name || 'Unknown',
        series.cover || (series as any).stream_icon,
        episode.season_num,
        episode.episode_num,
        episode.title || `Episode ${episode.episode_num}`
      );

      // Record episode progress for tracking
      // Calculate duration carefully to avoid NaN
      let episodeDuration = episode.duration ?? 0;
      if (!episodeDuration && episode.info?.duration) {
        const parsedDuration = Number(episode.info.duration);
        episodeDuration = isNaN(parsedDuration) ? 0 : parsedDuration;
      }
      console.log('[SeriesDetail] Episode duration:', episodeDuration, '(from duration:', episode.duration, ', info.duration:', episode.info?.duration + ')');

      void recordEpisodeWatch(
        episode.id,
        series.series_id,
        series.source_id,
        episode.season_num,
        episode.episode_num,
        episode.title || `Episode ${episode.episode_num}`,
        resumePosition, // Will be updated when stopped
        episodeDuration
      );

      // Use episode-specific synopsis if available from lazy-loaded extras
      const extra = episodeExtras.get(`${episode.season_num}_${episode.episode_num}`);
      const episodePlot = extra?.summary || episode.plot || lazyPlot || series.plot;

      onPlayEpisode?.({
        url: episode.direct_url,
        title: series.title || series.name,
        year: series.year || series.release_date?.slice(0, 4),
        plot: episodePlot,
        type: 'series',
        episodeInfo: `S${episode.season_num} E${episode.episode_num}${episode.title ? ` · ${episode.title}` : ''}`,
        source_id: series.source_id,
        mediaId: `${series.series_id}_ep_${episode.id}`,  // Episode-specific media ID
        // Series navigation fields
        seriesId: series.series_id,
        seasonNum: episode.season_num,
        episodeNum: episode.episode_num,
        episodeId: episode.id,
        posterUrl: series.cover || (series as any).stream_icon || (series as any).poster || undefined,
        backdropUrl: backdropUrl || undefined,
        logoUrl: logoUrl || undefined,
        tmdbId: series.tmdb_id,
        imdbId: series.imdb_id,
      }, targetMode);
    },
    [series, onPlayEpisode, lazyPlot, episodeProgress, episodeExtras, backdropUrl, logoUrl]
  );

  const handleToggleWatched = useCallback(async (episode: StoredEpisode, e: React.MouseEvent) => {
    e.stopPropagation();
    const progress = episodeProgress.get(episode.id);
    const isCompleted = progress?.completed || false;
    
    try {
      await setVodEpisodeWatchedState(
        series.series_id,
        episode.id,
        series.source_id,
        episode.season_num,
        episode.episode_num,
        episode.title || `Episode ${episode.episode_num}`,
        series.title || series.name || 'Unknown',
        series.cover || (series as any).stream_icon,
        !isCompleted
      );
    } catch (err) {
      console.error('[SeriesDetail] Failed to toggle watched state:', err);
    }
  }, [series, episodeProgress]);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const handleCopy = useCallback(
    async (episode: StoredEpisode, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!episode.direct_url) return;
      setCopyingId(episode.id);
      try {
        const resolved = await resolvePlayUrl(series.source_id, episode.direct_url);
        await navigator.clipboard.writeText(resolved.url);
        setCopiedId(episode.id);
        setTimeout(() => setCopiedId(null), 2000);
      } catch (error) {
        console.error('[SeriesDetail] Copy stream URL failed:', error);
        alert(i18n.t('vod:failedResolveCopy'));
      } finally {
        setCopyingId(null);
      }
    },
    [series.source_id]
  );

  // Active TMDB Token & Trailer logic
  const activeTmdbToken = useActiveTmdbToken();
  const hasTmdbKey = Boolean(activeTmdbToken && activeTmdbToken.trim() !== '');
  const { sourceTrailerUrl, tmdbTrailerUrl, loading: trailerLoading } = useLazyVodTrailer(series, 'series', activeTmdbToken);
  const [trailerPlayerMode, setTrailerPlayerMode] = useTrailerPlayerMode();
  const [trailerSource, setTrailerSource] = useTrailerSource();

  const hasSourceTrailer = Boolean(sourceTrailerUrl);
  const hasTmdbTrailer = Boolean(tmdbTrailerUrl);
  const hasBothTrailers = hasSourceTrailer && hasTmdbTrailer;
  const effectiveTrailerUrl = trailerSource === 'tmdb'
    ? (tmdbTrailerUrl || sourceTrailerUrl)
    : (sourceTrailerUrl || tmdbTrailerUrl);

  const handlePlayTrailer = useCallback((targetMode?: VodPlayerMode) => {
    if (!effectiveTrailerUrl) {
      alert(i18n.t('vod:noTrailerSeries'));
      return;
    }
    const modeToUse = targetMode || trailerPlayerMode;
    window.dispatchEvent(new CustomEvent('ynotv:play-url', {
      detail: {
        url: effectiveTrailerUrl,
        title: `${series.title || series.name} ${i18n.t('vod:trailerSuffix')}`,
        backdropUrl,
        logoUrl,
        targetMode: modeToUse,
      },
    }));
  }, [effectiveTrailerUrl, series, backdropUrl, logoUrl, trailerPlayerMode]);

  // Use clean title if available, otherwise fall back to name
  const displayTitle = series.title || series.name;

  // Use year field if available, otherwise extract from release_date
  const year = series.year || series.release_date?.slice(0, 4);

  // Rating - use lazy rating from hook if available, otherwise use stored rating
  const rawRating = series.rating;
  let storedRating = rawRating && typeof rawRating === 'string' ? rawRating.trim() : null;
  if (storedRating && storedRating.startsWith('"') && storedRating.endsWith('"')) {
    storedRating = storedRating.slice(1, -1);
  }
  const ratingSource = storedRating || (lazyRating ? lazyRating.toString() : null);
  const parsedRating = ratingSource ? parseFloat(ratingSource) : NaN;
  const rating = !isNaN(parsedRating) && parsedRating > 0 ? parsedRating : null;
  const genreSource = series.genre || lazyGenre;
  const genres = genreSource?.split(',').map((g) => g.trim()).filter(Boolean) ?? [];

  // Current season episodes
  const currentEpisodes = seasons[selectedSeason] ?? [];

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      containerRef.current?.scrollBy({ top: 200, behavior: 'smooth' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      containerRef.current?.scrollBy({ top: -200, behavior: 'smooth' });
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      containerRef.current?.scrollBy({ top: 500, behavior: 'smooth' });
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      containerRef.current?.scrollBy({ top: -500, behavior: 'smooth' });
    }
  }, []);

  return (
    <>
      {/* Fixed background & hero image that NEVER moves when scrolling */}
      <div className="series-detail-fixed-backdrop">
        {backdropUrl && <img src={backdropUrl} alt="" aria-hidden="true" />}
        <div className="series-detail-fixed-backdrop-gradient" />
      </div>

      <div
        className="series-detail"
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        style={{ outline: 'none' }}
      >
        {/* Header with back button */}
        <header className="series-detail__header">
          <button
            className="series-detail__back"
            onClick={onClose}
            aria-label={i18n.t('vod:goBack')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {i18n.t('vod:back')}
          </button>

          <button
            className="series-detail__fav-btn series-detail__edit-meta"
            onClick={() => setIsMetadataEditOpen(true)}
            title={i18n.t('vod:editMetadata')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {i18n.t('vod:editMetadata')}
          </button>
        </header>

      {/* Content */}
      <div className="series-detail__content">
        {/* Hero Section */}
        <div className="series-detail__hero">
          {/* Poster */}
          <div className="series-detail__poster">
            {posterUrl ? (
              <img src={posterUrl} alt={series.name} />
            ) : (
              <div className="series-detail__poster-placeholder">
                <span>{series.name.charAt(0).toUpperCase()}</span>
              </div>
            )}
          </div>

          {/* Info */}
          <div className="series-detail__info">
            {/* Logo or Title */}
            {logoUrl ? (
              <div className="series-detail__logo">
                <img src={logoUrl} alt={displayTitle} />
              </div>
            ) : (
              <h1 className="series-detail__title">{displayTitle}</h1>
            )}

            <div className="series-detail__meta">
              {year && <span className="series-detail__year">{year}</span>}
              {rating !== null && (
                <span className="series-detail__rating">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                  {rating.toFixed(1)}
                </span>
              )}
              {seasonNumbers.length > 0 && (
                <span className="series-detail__seasons-count">
                  {i18n.t('vod:seasonCount', { count: seasonNumbers.length })}
                </span>
              )}
            </div>

            {genres.length > 0 && (
              <div className="series-detail__genres">
                {genres.map((genre) => (
                  <span key={genre} className="series-detail__genre">
                    {genre}
                  </span>
                ))}
              </div>
            )}

            {(series.plot || lazyPlot) && (
              <p className="series-detail__description">{series.plot || lazyPlot}</p>
            )}

            {/* Credits */}
            {lazyCredits.cast && (
              <div className="series-detail__credits">
                <span className="series-detail__credit-label">{i18n.t('vod:cast')}</span>
                <span className="series-detail__credit-value">
                  {lazyCredits.cast.split(',').map((name, index, array) => {
                    const cleanName = name.trim();
                    if (!cleanName) return null;
                    return (
                      <span key={cleanName}>
                        <button
                          className="series-detail__cast-link-btn"
                          onClick={() => handleCastNameClick(cleanName)}
                          title={i18n.t('vod:viewName', { name: cleanName })}
                        >
                          {cleanName}
                        </button>
                        {index < array.length - 1 && ', '}
                      </span>
                    );
                  })}
                </span>
              </div>
            )}

            {/* Header Action Buttons (Set Player & Favorite & Trailer) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '16px', flexWrap: 'wrap' }}>
              <SetPlayerDropdown
                currentMode={vodPlayerMode}
                onSelectMode={onSelectVodPlayerMode}
              />

              <button
                className={`series-detail__fav-btn ${isFav ? 'favorited' : ''}`}
                onClick={handleToggleFavorite}
                title={isFav ? i18n.t('vod:removeFavorite') : i18n.t('vod:addFavorite')}
              >
                <svg viewBox="0 0 24 24" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {isFav ? i18n.t('vod:removeFavorite') : i18n.t('vod:addFavorite')}
              </button>

              <button
                className="series-detail__fav-btn"
                onClick={() => {
                  setPreselectedEpisode(null);
                  setIsPlaylistModalOpen(true);
                }}
                title={i18n.t('vod:addToPlaylist')}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6" strokeLinecap="round" />
                  <line x1="8" y1="12" x2="21" y2="12" strokeLinecap="round" />
                  <line x1="8" y1="18" x2="21" y2="18" strokeLinecap="round" />
                  <line x1="3" y1="6" x2="3.01" y2="6" strokeLinecap="round" />
                  <line x1="3" y1="12" x2="3.01" y2="12" strokeLinecap="round" />
                  <line x1="3" y1="18" x2="3.01" y2="18" strokeLinecap="round" />
                </svg>
                {i18n.t('vod:addToPlaylist')}
              </button>

              {(hasTmdbKey || hasSourceTrailer || trailerLoading) && (
                <TrailerSplitButton
                  loading={trailerLoading}
                  disabled={trailerLoading || (!effectiveTrailerUrl && !trailerLoading)}
                  trailerSource={trailerSource}
                  onSelectSource={setTrailerSource}
                  hasBothSources={hasBothTrailers}
                  playerMode={trailerPlayerMode}
                  onSelectMode={setTrailerPlayerMode}
                  onPlay={handlePlayTrailer}
                />
              )}
            </div>
          </div>
        </div>

        {/* Episodes section */}
        <div className="series-detail__episodes-section">
          <div className="series-detail__season-header-row">
            {/* Season selector - row of buttons */}
            <div className="series-detail__season-selector">
              {seasonNumbers.map((num) => (
                <button
                  key={num}
                  className={`series-detail__season-btn ${selectedSeason === num ? 'active' : ''}`}
                  onClick={() => setSelectedSeason(num)}
                >
                  {i18n.t('vod:seasonNum', { num })}
                </button>
              ))}
            </div>

            {currentEpisodes.length > 0 && (
              <button
                className={`series-detail__download-season-btn ${downloadingSeason ? 'downloading' : ''}`}
                onClick={handleDownloadSeason}
                disabled={downloadingSeason}
                title={i18n.t('vod:downloadSeasonTitle', { season: selectedSeason })}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {downloadingSeason ? (
                    <circle cx="12" cy="12" r="10" strokeDasharray="31.4" strokeDashoffset="10" style={{ transformOrigin: 'center', animation: 'spin 1.5s linear infinite' }} />
                  ) : (
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3" strokeLinecap="round" strokeLinejoin="round" />
                  )}
                </svg>
                {downloadingSeason ? i18n.t('vod:queueingSeason') : i18n.t('vod:downloadSeason', { num: selectedSeason })}
              </button>
            )}
          </div>

          {/* Episode list */}
          <div className="series-detail__episodes">
            {loading ? (
              <div className="series-detail__loading">
                <div className="series-detail__spinner" />
                <span>{i18n.t('vod:loadingEpisodes')}</span>
              </div>
            ) : error ? (
              <div className="series-detail__error">
                <p>{error}</p>
                <button onClick={refetch}>{i18n.t('common:retry')}</button>
              </div>
            ) : currentEpisodes.length === 0 ? (
              <div className="series-detail__empty">
                <p>{i18n.t('vod:noEpisodesFound', { num: selectedSeason })}</p>
              </div>
            ) : (
              <div className="series-detail__episode-grid">
                {currentEpisodes.map((episode) => {
                  const progress = episodeProgress.get(episode.id);
                  const hasProgress = progress && progress.progressPercent > 0 && !progress.completed;
                  const isCompleted = progress?.completed || false;
                  const extra = episodeExtras.get(`${episode.season_num}_${episode.episode_num}`);

                  return (
                    <div
                      key={episode.id}
                      className={`series-detail__episode-card ${hasProgress ? 'has-progress' : ''} ${isCompleted ? 'completed' : ''}`}
                      onClick={() => handlePlayEpisode(episode)}
                    >
                      {/* Episode Image */}
                      <div className="series-detail__episode-image">
                        {extra?.image ? (
                          <img src={extra.image} alt={episode.title || i18n.t('vod:episodeNum', { num: episode.episode_num })} loading="lazy" />
                        ) : (
                          <div className="series-detail__episode-image-placeholder">
                            <span>E{episode.episode_num}</span>
                          </div>
                        )}
                        {/* Play overlay */}
                        <div className="series-detail__episode-play-overlay">
                          <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </div>
                        {/* Progress bar */}
                        {hasProgress && (
                          <div className="series-detail__episode-progress-bar">
                            <div
                              className="series-detail__episode-progress-fill"
                              style={{ width: `${progress.progressPercent}%` }}
                            />
                          </div>
                        )}
                        {/* Watched toggle badge */}
                        <button
                          className={`series-detail__episode-completed-badge ${isCompleted ? 'completed' : ''}`}
                          onClick={(e) => handleToggleWatched(episode, e)}
                          title={isCompleted ? i18n.t('vod:markUnwatched') : i18n.t('vod:markWatched')}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={isCompleted ? "3.5" : "2"}>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </button>
                      </div>

                      {/* Episode Info */}
                      <div className="series-detail__episode-card-info">
                        <div className="series-detail__episode-card-header">
                          <span className="series-detail__episode-card-number">
                            {episode.episode_num}
                          </span>
                          <span className="series-detail__episode-card-title">
                            {episode.title || i18n.t('vod:episodeNum', { num: episode.episode_num })}
                          </span>
                        </div>

                        {/* Meta: air date, rating */}
                        <div className="series-detail__episode-card-meta">
                          {extra?.airDate && (
                            <span className="series-detail__episode-card-airdate">
                              {formatAirDate(extra.airDate)}
                            </span>
                          )}
                          {extra?.rating && (
                            <span className="series-detail__episode-card-rating">
                              <svg viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                              </svg>
                              {extra.rating.toFixed(1)}
                            </span>
                          )}
                        </div>

                        {/* Summary */}
                        {extra?.summary && (
                          <p className="series-detail__episode-card-summary">{extra.summary}</p>
                        )}
                      </div>

                      {/* Add to Playlist button */}
                      <button
                        className="series-detail__episode-card-copy"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPreselectedEpisode(episode);
                          setIsPlaylistModalOpen(true);
                        }}
                        title={i18n.t('vod:addToPlaylist')}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="8" y1="6" x2="21" y2="6" strokeLinecap="round" />
                          <line x1="8" y1="12" x2="21" y2="12" strokeLinecap="round" />
                          <line x1="8" y1="18" x2="21" y2="18" strokeLinecap="round" />
                          <line x1="3" y1="6" x2="3.01" y2="6" strokeLinecap="round" />
                          <line x1="3" y1="12" x2="3.01" y2="12" strokeLinecap="round" />
                          <line x1="3" y1="18" x2="3.01" y2="18" strokeLinecap="round" />
                        </svg>
                      </button>

                      {/* Copy URL button */}
                      {episode.direct_url && (
                        <button
                          className={`series-detail__episode-card-copy ${copiedId === episode.id ? 'copied' : ''}`}
                          onClick={(e) => handleCopy(episode, e)}
                          disabled={copyingId === episode.id}
                          title={i18n.t('vod:copyStreamUrl')}
                        >
                          {copyingId === episode.id ? (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="10" strokeDasharray="31.4" strokeDashoffset="10" style={{ transformOrigin: 'center', animation: 'spin 1.5s linear infinite' }} />
                            </svg>
                          ) : copiedId === episode.id ? (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </button>
                      )}

                      {/* Download button */}
                      {episode.direct_url && (
                        <button
                          className={`series-detail__episode-card-download ${downloadingId === episode.id ? 'downloading' : ''}`}
                          onClick={(e) => handleDownloadEpisode(episode, e)}
                          disabled={downloadingId === episode.id}
                          title={i18n.t('vod:downloadEpisode')}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            {downloadingId === episode.id ? (
                              <circle cx="12" cy="12" r="10" strokeDasharray="31.4" strokeDashoffset="10" style={{ transformOrigin: 'center', animation: 'spin 1.5s linear infinite' }} />
                            ) : (
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3" strokeLinecap="round" strokeLinejoin="round" />
                            )}
                          </svg>
                        </button>
                      )}


                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>

    <AddToPlaylistModal
      isOpen={isPlaylistModalOpen}
      onClose={() => setIsPlaylistModalOpen(false)}
      series={series}
      seasons={seasons}
      preselectedEpisode={preselectedEpisode}
      sourceName={sourceNameMap?.get(series.source_id)}
      posterUrl={posterUrl}
    />

    <VodMetadataEditModal
      isOpen={isMetadataEditOpen}
      onClose={() => setIsMetadataEditOpen(false)}
      item={series}
      type="series"
    />
  </>
);
}

function formatAirDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return formatDate(date, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export default SeriesDetail;
