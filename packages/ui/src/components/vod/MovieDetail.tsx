/**
 * MovieDetail - Full page movie detail view
 *
 * Shows movie information with backdrop, logo, metadata, cast photos,
 * and play button. Slides in as a full page, not a modal.
 */

import { useEffect, useCallback, useState, useMemo } from 'react';
import { getTmdbImageUrl, TMDB_POSTER_SIZES } from '../../services/tmdb';
import { useLazyBackdrop } from '../../hooks/useLazyBackdrop';
import { useLazyPlot } from '../../hooks/useLazyPlot';
import { useLazyMovieExtras } from '../../hooks/useLazyMovieExtras';
import { useRpdbSettings } from '../../hooks/useRpdbSettings';
import { getRpdbPosterUrl } from '../../services/rpdb';
import type { StoredMovie } from '../../db';
import { resolvePlayUrl } from '../../services/stream-resolver';
import { useDownloadStore } from '../../stores/downloadStore';
import { useVodFavoritesStore } from '../../stores/vodFavoritesStore';
import { useActiveTmdbToken } from '../../hooks/useTmdbLists';
import { useLazyVodTrailer, useTrailerPlayerMode, useTrailerSource } from '../../hooks/useLazyVodTrailer';
import { SplitPlayButton, TrailerSplitButton, type VodPlayerMode } from './SplitPlayButton';
import { AddToPlaylistModal } from './AddToPlaylistModal';
import { VodMetadataEditModal } from './VodMetadataEditModal';
import { useSourceNameMap } from '../../hooks/useChannels';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import {
  useVodMetadataOverridesStore,
  overrideKey,
  applyVodMetadataOverride,
} from '../../stores/vodMetadataOverridesStore';
import './MovieDetail.css';

export interface MovieDetailProps {
  movie: StoredMovie;
  onClose: () => void;
  onPlay?: (movie: StoredMovie, plot?: string | null, backdropUrl?: string | null, logoUrl?: string | null, targetMode?: VodPlayerMode) => void;
  apiKey?: string | null; // TMDB API key for lazy backdrop loading
  onCastClick?: (personId: number) => void;
  vodPlayerMode?: VodPlayerMode;
  onSelectVodPlayerMode?: (mode: VodPlayerMode) => void;
}

export function MovieDetail({ movie: movieProp, onClose, onPlay, apiKey, onCastClick, vodPlayerMode, onSelectVodPlayerMode }: MovieDetailProps) {
  useTranslation();
  const sourceNameMap = useSourceNameMap();

  // Merge user-corrected metadata (title/year/poster/plot/tmdb_id) on top of
  // the provider row. The override table is never touched by sync, so edits
  // survive provider refreshes. Everything below uses the merged movie.
  const metadataOverride = useVodMetadataOverridesStore((s) => s.overrides[overrideKey(movieProp.stream_id, 'movie')]);
  const movie = useMemo(() => applyVodMetadataOverride(movieProp, metadataOverride), [movieProp, metadataOverride]);
  // Bumped on every override save so the lazy cast/logo hooks re-fetch even
  // when the edit didn't change title/tmdb/year. overrideTmdbId tells the hook
  // to trust the user-pinned TMDB id instead of re-searching after a title fix.
  const metadataVersion = metadataOverride?.updated_at ?? 0;
  const overrideTmdbId = metadataOverride?.tmdb_id ?? undefined;

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

  // Lazy-load backdrop, plot, genre from TMDB if available
  const tmdbBackdropUrl = useLazyBackdrop(movie, apiKey);
  const { plot: lazyPlot, genre: lazyGenre, rating: lazyRating } = useLazyPlot(movie, apiKey);

  // Lazy-load cast photos, logo, imdb_id, country, language
  const { cast, logoUrl, imdbId, country, language, loading: extrasLoading } = useLazyMovieExtras(movie, apiKey, metadataVersion, overrideTmdbId);

  // Get images - use TMDB backdrop if available, fallback to stream_icon
  const backdropUrl = tmdbBackdropUrl || movie.stream_icon;

  const handlePlay = useCallback(() => {
    onPlay?.(movie, lazyPlot || movie.plot, backdropUrl, logoUrl);
  }, [movie, onPlay, lazyPlot, backdropUrl, logoUrl]);

  const [isPlaylistModalOpen, setIsPlaylistModalOpen] = useState(false);
  const [isMetadataEditOpen, setIsMetadataEditOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const handleCopy = useCallback(async () => {
    if (!movie.direct_url) return;
    setCopying(true);
    try {
      const resolved = await resolvePlayUrl(movie.source_id, movie.direct_url);
      await navigator.clipboard.writeText(resolved.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('[MovieDetail] Failed to copy stream URL:', error);
      alert(i18n.t('vod:failedResolveCopy'));
    } finally {
      setCopying(false);
    }
  }, [movie]);

  // Active TMDB Token & Trailer logic
  const activeTmdbToken = useActiveTmdbToken();
  const hasTmdbKey = Boolean(activeTmdbToken && activeTmdbToken.trim() !== '');
  const { sourceTrailerUrl, tmdbTrailerUrl, loading: trailerLoading } = useLazyVodTrailer(movie, 'movie', activeTmdbToken);
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
      alert(i18n.t('vod:noTrailerMovie'));
      return;
    }
    const modeToUse = targetMode || trailerPlayerMode;
    window.dispatchEvent(new CustomEvent('ynotv:play-url', {
      detail: {
        url: effectiveTrailerUrl,
        title: `${movie.title || movie.name} ${i18n.t('vod:trailerSuffix')}`,
        backdropUrl,
        logoUrl,
        targetMode: modeToUse,
      },
    }));
  }, [effectiveTrailerUrl, movie, backdropUrl, logoUrl, trailerPlayerMode]);

  // Load RPDB settings for poster
  const { apiKey: rpdbApiKey } = useRpdbSettings();
  const rpdbPosterUrl = rpdbApiKey && movie.tmdb_id
    ? getRpdbPosterUrl(rpdbApiKey, movie.tmdb_id, 'movie')
    : null;

  // Priority: RPDB poster > local poster > TMDB fallback
  const posterUrl = rpdbPosterUrl || movie.stream_icon ||
    (movie.backdrop_path
      ? getTmdbImageUrl(movie.backdrop_path, TMDB_POSTER_SIZES.medium)
      : null);

  const [downloading, setDownloading] = useState(false);
  const startDownload = useDownloadStore((s) => s.startDownload);

  const isFav = useVodFavoritesStore((s) => s.isFavorite(movie.stream_id, 'movie'));
  const addFavorite = useVodFavoritesStore((s) => s.addFavorite);
  const removeFavorite = useVodFavoritesStore((s) => s.removeFavorite);
  const handleToggleFavorite = useCallback(() => {
    if (isFav) {
      removeFavorite(movie.stream_id, 'movie');
    } else {
      addFavorite({
        id: movie.stream_id,
        type: 'movie',
        title: movie.title || movie.name,
        poster: movie.stream_icon,
        year: movie.year || movie.release_date?.slice(0, 4),
      });
    }
  }, [isFav, movie, addFavorite, removeFavorite]);

  const handleDownload = useCallback(async () => {
    if (!movie.direct_url) return;
    setDownloading(true);
    try {
      const resolved = await resolvePlayUrl(movie.source_id, movie.direct_url);
      await startDownload(
        movie.title || movie.name,
        resolved.url,
        resolved.userAgent,
        movie.duration ? movie.duration * 60 : undefined,
        undefined,
        posterUrl || undefined,
        movie.source_id,
        movie.direct_url
      );
    } catch (error) {
      console.error('[MovieDetail] Download failed:', error);
      alert(i18n.t('vod:failedStartDownload'));
    } finally {
      setDownloading(false);
    }
  }, [movie, startDownload, posterUrl]);

  // Use clean title if available, otherwise fall back to name
  const displayTitle = movie.title || movie.name;

  // Use year field if available, otherwise extract from release_date
  const year = movie.year || movie.release_date?.slice(0, 4);

  // Rating - prefer lazy rating, then stored rating
  const rawRating = movie.rating;
  let storedRating = rawRating && typeof rawRating === 'string' ? rawRating.trim() : null;
  if (storedRating && storedRating.startsWith('"') && storedRating.endsWith('"')) {
    storedRating = storedRating.slice(1, -1);
  }
  const ratingSource = storedRating || (lazyRating ? lazyRating.toString() : null);
  const parsedRating = ratingSource ? parseFloat(ratingSource) : NaN;
  const rating = !isNaN(parsedRating) && parsedRating > 0 ? parsedRating : null;

  // Use provider metadata if available, otherwise fall back to TMDB
  const genreSource = movie.genre != null ? movie.genre : lazyGenre;
  const genres = genreSource?.split(',').map((g) => g.trim()).filter(Boolean) ?? [];
  const duration = movie.duration && movie.duration > 0
    ? i18n.t('vod:durationHM', { hours: Math.floor(movie.duration / 60), minutes: movie.duration % 60 })
    : null;

  return (
    <>
      {/* Fixed background & hero image that NEVER moves when scrolling */}
      <div className="movie-detail-fixed-backdrop">
        {backdropUrl && <img src={backdropUrl} alt="" aria-hidden="true" />}
        <div className="movie-detail-fixed-backdrop-gradient" />
      </div>

      <div className="movie-detail">
        {/* Header with back button */}
        <header className="movie-detail__header">
          <button
            className="movie-detail__back"
            onClick={onClose}
            aria-label={i18n.t('vod:goBack')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {i18n.t('vod:back')}
          </button>

          <button
            className="movie-detail__btn movie-detail__btn--secondary movie-detail__edit-meta"
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
      <div className="movie-detail__content">
        <div className="movie-detail__hero">
          {/* Poster */}
          <div className="movie-detail__poster">
            {posterUrl ? (
              <img src={posterUrl} alt={movie.name} />
            ) : (
              <div className="movie-detail__poster-placeholder">
                <span>{movie.name.charAt(0).toUpperCase()}</span>
              </div>
            )}
          </div>

          {/* Info */}
          <div className="movie-detail__info">
            {/* Logo or Title */}
            {logoUrl ? (
              <div className="movie-detail__logo">
                <img src={logoUrl} alt={displayTitle} />
              </div>
            ) : (
              <h1 className="movie-detail__title">{displayTitle}</h1>
            )}

            <div className="movie-detail__meta">
              {year && <span className="movie-detail__year">{year}</span>}
              {rating && (
                <span className="movie-detail__rating">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                  {rating.toFixed(1)}
                </span>
              )}
              {duration && (
                <span className="movie-detail__duration">{duration}</span>
              )}
              {imdbId && (
                <a
                  className="movie-detail__imdb-link"
                  href={`https://www.imdb.com/title/${imdbId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  IMDb
                </a>
              )}
              {country && (
                <span className="movie-detail__country">{country}</span>
              )}
              {language && (
                <span className="movie-detail__language">{language}</span>
              )}
            </div>

            {genres.length > 0 && (
              <div className="movie-detail__genres">
                {genres.map((genre) => (
                  <span key={genre} className="movie-detail__genre">
                    {genre}
                  </span>
                ))}
              </div>
            )}

            {/* Plot */}
            {(movie.plot != null ? movie.plot : lazyPlot) && (
              <p className="movie-detail__description">{movie.plot != null ? movie.plot : lazyPlot}</p>
            )}

            {/* Actions */}
            <div className="movie-detail__actions">
              <SplitPlayButton
                currentMode={vodPlayerMode}
                onSelectMode={onSelectVodPlayerMode}
                onPlay={(targetMode) => {
                  onPlay?.(movie, lazyPlot || movie.plot, backdropUrl, logoUrl, targetMode);
                }}
              />

              <button
                className={`movie-detail__btn movie-detail__btn--secondary ${isFav ? 'favorited' : ''}`}
                onClick={handleToggleFavorite}
                title={isFav ? i18n.t('vod:removeFavorite') : i18n.t('vod:addFavorite')}
              >
                <svg viewBox="0 0 24 24" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {isFav ? i18n.t('vod:removeFavorite') : i18n.t('vod:addFavorite')}
              </button>

              <button
                className="movie-detail__btn movie-detail__btn--secondary"
                onClick={() => setIsPlaylistModalOpen(true)}
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

              {movie.direct_url && (
                <button
                  className="movie-detail__btn movie-detail__btn--secondary"
                  onClick={handleDownload}
                  disabled={downloading}
                  title={i18n.t('vod:download')}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {downloading ? i18n.t('vod:resolving') : i18n.t('vod:download')}
                </button>
              )}

              {movie.direct_url && (
                <button
                  className={`movie-detail__btn movie-detail__btn--secondary ${copied ? 'copied' : ''}`}
                  onClick={handleCopy}
                  disabled={copying}
                  title={i18n.t('vod:copyStreamUrl')}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {copied ? (
                      <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                    ) : (
                      <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" />
                    )}
                  </svg>
                  {copying ? i18n.t('vod:resolving') : copied ? i18n.t('vod:copiedUrl') : i18n.t('vod:copyStreamUrl')}
                </button>
              )}

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

        {/* Cast Section */}
        {cast.length > 0 && (
          <div className="movie-detail__cast-section">
            <h2 className="movie-detail__section-title">{i18n.t('vod:cast')}</h2>
            <div className="movie-detail__cast-row">
              {cast.map((member, idx) => (
                <button
                  key={`${member.name}-${idx}`}
                  className="movie-detail__cast-member"
                  onClick={() => {
                    if (member.id) {
                      if (onCastClick) {
                        onCastClick(member.id);
                      } else {
                        window.dispatchEvent(new CustomEvent('ynotv:navigate-to-person', {
                          detail: { personId: member.id }
                        }));
                      }
                    }
                  }}
                  title={i18n.t('vod:viewName', { name: member.name })}
                >
                  <div className="movie-detail__cast-photo">
                    {member.photo ? (
                      <img src={member.photo} alt={member.name} loading="lazy" />
                    ) : (
                      <div className="movie-detail__cast-photo-placeholder">
                        <span>{member.name.charAt(0)}</span>
                      </div>
                    )}
                  </div>
                  <span className="movie-detail__cast-name">{member.name}</span>
                  <span className="movie-detail__cast-character">{member.character}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>

    <AddToPlaylistModal
      isOpen={isPlaylistModalOpen}
      onClose={() => setIsPlaylistModalOpen(false)}
      movie={movie}
      sourceName={sourceNameMap?.get(movie.source_id)}
      posterUrl={posterUrl}
    />

    <VodMetadataEditModal
      isOpen={isMetadataEditOpen}
      onClose={() => setIsMetadataEditOpen(false)}
      item={movie}
      type="movie"
    />
  </>
);
}

export default MovieDetail;
