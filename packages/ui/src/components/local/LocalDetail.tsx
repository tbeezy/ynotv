import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { LocalEntry, LocalGroup } from '../../services/local-library/types';
import {
  useLocalMovieWatchStatus,
  useLocalEpisodeWatchStatus,
  markLocalMovieWatched,
  markLocalEpisodeWatched,
} from '../../services/local-library/local-watch';
import {
  getCachedCast,
  getCachedSeasonEpisodes,
  type CachedCastMember as CastMember,
  type CachedSeasonEpisode as TmdbSeasonEpisode,
} from '../../services/local-library/metadata-cache';
import { useActiveTmdbToken } from '../../hooks/useTmdbLists';
import './LocalDetail.css';

interface LocalDetailProps {
  group: LocalGroup;
  onClose: () => void;
  onPlay: (entry: LocalEntry, seriesGroup?: { key: string; head: LocalEntry }) => void;
  onFixMatch: (entries: LocalEntry[]) => void;
  onRemove: (ids: string[]) => void;
}

function LocalEpisodeCard({
  episode,
  seriesTitle,
  tmdbEpisode,
  seriesBackdrop,
  onPlay,
}: {
  episode: LocalEntry;
  seriesTitle: string;
  tmdbEpisode?: TmdbSeasonEpisode | null;
  seriesBackdrop?: string | null;
  onPlay: (episode: LocalEntry) => void;
}) {
  const { t } = useTranslation('vod');
  const watchStatus = useLocalEpisodeWatchStatus(episode);
  const epNum = episode.episode ?? tmdbEpisode?.episode_number ?? 1;

  const handleToggleWatched = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      await markLocalEpisodeWatched(episode, seriesTitle, !watchStatus.completed);
    },
    [episode, seriesTitle, watchStatus.completed],
  );

  const handleShowInFolder = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await invoke('open_file_location', { filePath: episode.path });
      } catch (err) {
        console.error('[LocalEpisodeCard] Failed to open folder:', err);
      }
    },
    [episode.path],
  );

  // Determine thumbnail image
  let stillSrc: string | null = null;
  if (tmdbEpisode?.still_path) {
    stillSrc = `https://image.tmdb.org/t/p/w500${tmdbEpisode.still_path}`;
  } else if (episode.localArt?.poster || episode.localArt?.backdrop) {
    const art = episode.localArt.backdrop || episode.localArt.poster!;
    stillSrc = art.startsWith('http') || art.startsWith('asset:') || art.startsWith('data:')
      ? art
      : convertFileSrc(art);
  } else if (seriesBackdrop) {
    stillSrc = seriesBackdrop;
  }

  // Duration
  const runtimeMin =
    tmdbEpisode?.runtime ||
    episode.runtime ||
    (watchStatus.totalDuration > 0 ? Math.round(watchStatus.totalDuration / 60) : null);
  const durationLabel = runtimeMin ? `${runtimeMin}m` : null;

  // Title & Overview
  const displayTitle =
    tmdbEpisode?.name && !tmdbEpisode.name.toLowerCase().startsWith('episode ')
      ? tmdbEpisode.name
      : episode.title !== seriesTitle && episode.title
        ? episode.title
        : tmdbEpisode?.name || `Episode ${epNum}`;

  const displayOverview = tmdbEpisode?.overview || episode.overview || '';

  return (
    <div
      className="local-detail__episode-card"
      onClick={() => onPlay(episode)}
      title={`${displayTitle} (${episode.filename})`}
    >
      {/* 16:9 Thumbnail Screen Cap */}
      <div className="local-detail__ep-thumb-wrap">
        {stillSrc ? (
          <img
            src={stillSrc}
            alt={displayTitle}
            className="local-detail__ep-thumb-img"
            loading="lazy"
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(135deg, #1c1c1c 0%, #282828 100%)',
              color: 'rgba(255,255,255,0.25)',
            }}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
              <polyline points="17 2 12 7 7 2" />
            </svg>
          </div>
        )}

        {/* Episode Number Pill */}
        <div className="local-detail__ep-number-badge">
          {epNum}
        </div>

        {/* Rating Badge (if available and no watched checkmark) */}
        {!watchStatus.completed && tmdbEpisode?.vote_average && tmdbEpisode.vote_average > 0 && (
          <div className="local-detail__ep-rating-badge">
            <span>★</span> {tmdbEpisode.vote_average.toFixed(1)}
          </div>
        )}

        {/* Watched Checkmark Badge */}
        {watchStatus.completed && (
          <div className="local-detail__ep-watched-badge" title={t('watched', 'Watched')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        )}

        {/* Duration Badge */}
        {durationLabel && (
          <div className="local-detail__ep-duration-badge">
            {durationLabel}
          </div>
        )}

        {/* Hover Play Circle Overlay */}
        <div className="local-detail__ep-play-overlay">
          <div className="local-detail__ep-play-circle">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
        </div>

        {/* Watch Progress Bar */}
        {watchStatus.progressPercent > 0 && (
          <div className="local-detail__ep-progress-bar">
            <div
              className="local-detail__ep-progress-fill"
              style={{
                width: `${watchStatus.completed ? 100 : watchStatus.progressPercent}%`,
                background: watchStatus.completed ? 'var(--status-new, #2ecc71)' : 'var(--accent-primary, #00d4ff)',
              }}
            />
          </div>
        )}
      </div>

      {/* Episode Text Content */}
      <div className="local-detail__ep-body">
        <h4 className="local-detail__ep-name" title={displayTitle}>
          {displayTitle}
        </h4>

        <p className="local-detail__ep-meta">
          E{epNum} {durationLabel ? `· ${durationLabel}` : ''} {episode.resolution ? `· ${episode.resolution}` : ''}
        </p>

        {displayOverview && (
          <p className="local-detail__ep-overview" title={displayOverview}>
            {displayOverview}
          </p>
        )}

        {/* Quick actions on card hover */}
        <div className="local-detail__ep-actions">
          <button
            type="button"
            className="local-detail__ep-action-btn"
            onClick={handleToggleWatched}
            title={watchStatus.completed ? t('markUnwatched', 'Mark as unwatched') : t('markWatched', 'Mark as watched')}
          >
            {watchStatus.completed ? 'Unwatch' : 'Watched'}
          </button>
          <button
            type="button"
            className="local-detail__ep-action-btn"
            onClick={handleShowInFolder}
            title={t('showInFolder', 'Show in folder')}
          >
            Folder
          </button>
        </div>
      </div>
    </div>
  );
}

export const LocalDetail = memo(function LocalDetail({
  group,
  onClose,
  onPlay,
  onFixMatch,
  onRemove,
}: LocalDetailProps) {
  const { t } = useTranslation('vod');
  const tmdbToken = useActiveTmdbToken();

  const isMovie = group.kind === 'movie';
  const head = isMovie ? group.entry : group.head;
  const episodes = isMovie ? [] : group.episodes;
  const allEntries = isMovie ? [group.entry] : episodes;

  const movieWatchStatus = useLocalMovieWatchStatus(isMovie ? group.entry : null);

  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [cast, setCast] = useState<CastMember[]>([]);
  const [seasonEpisodesMap, setSeasonEpisodesMap] = useState<Map<number, TmdbSeasonEpisode>>(new Map());
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Group series episodes by season
  const seasonsMap = useMemo(() => {
    if (isMovie) return new Map<number, LocalEntry[]>();
    const map = new Map<number, LocalEntry[]>();
    for (const ep of episodes) {
      const s = ep.season ?? 1;
      if (!map.has(s)) map.set(s, []);
      map.get(s)!.push(ep);
    }
    // Sort episodes in each season by episode number
    for (const [s, list] of map.entries()) {
      list.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
    }
    return map;
  }, [isMovie, episodes]);

  const seasonsList = useMemo(() => Array.from(seasonsMap.keys()).sort((a, b) => a - b), [seasonsMap]);

  useEffect(() => {
    if (seasonsList.length > 0 && !seasonsMap.has(selectedSeason)) {
      setSelectedSeason(seasonsList[0]);
    }
  }, [seasonsList, seasonsMap, selectedSeason]);

  // Escape key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Fetch & Cache TMDB Cast
  useEffect(() => {
    if (!head.tmdbId) {
      setCast([]);
      return;
    }
    let alive = true;
    getCachedCast(head.tmdbId, isMovie ? 'movie' : 'tv', tmdbToken).then((members) => {
      if (alive) setCast(members);
    });
    return () => {
      alive = false;
    };
  }, [head.tmdbId, tmdbToken, isMovie]);

  // Fetch & Cache TMDB Season Episodes with Still Photos & Overviews
  useEffect(() => {
    if (isMovie || !head.tmdbId) {
      setSeasonEpisodesMap(new Map());
      return;
    }

    let alive = true;
    getCachedSeasonEpisodes(head.tmdbId, selectedSeason, tmdbToken).then((epList) => {
      if (!alive) return;
      const map = new Map<number, TmdbSeasonEpisode>();
      for (const ep of epList) {
        if (ep.episode_number != null) {
          map.set(ep.episode_number, ep);
        }
      }
      setSeasonEpisodesMap(map);
    });

    return () => {
      alive = false;
    };
  }, [isMovie, head.tmdbId, selectedSeason, tmdbToken]);

  // Images
  const posterRaw = head.poster || head.localArt?.poster;
  const posterSrc = posterRaw
    ? (posterRaw.startsWith('http://') || posterRaw.startsWith('https://') || posterRaw.startsWith('data:') || posterRaw.startsWith('asset:')
      ? posterRaw
      : convertFileSrc(posterRaw))
    : null;

  const backdropRaw = head.backdrop || head.localArt?.backdrop;
  const backdropSrc = backdropRaw
    ? (backdropRaw.startsWith('http://') || backdropRaw.startsWith('https://') || backdropRaw.startsWith('data:') || backdropRaw.startsWith('asset:')
      ? backdropRaw
      : convertFileSrc(backdropRaw))
    : null;

  const logoRaw = head.logo || head.localArt?.logo;
  const logoSrc = logoRaw
    ? (logoRaw.startsWith('http://') || logoRaw.startsWith('https://') || logoRaw.startsWith('data:') || logoRaw.startsWith('asset:')
      ? logoRaw
      : convertFileSrc(logoRaw))
    : null;

  const handleOpenFolder = useCallback(async () => {
    try {
      await invoke('open_file_location', { filePath: head.path });
    } catch (e) {
      console.error('[LocalDetail] Failed to open file location:', e);
    }
  }, [head.path]);

  const handlePrimaryPlay = useCallback(() => {
    if (isMovie) {
      onPlay(head);
    } else if (episodes.length > 0) {
      onPlay(episodes[0], { key: group.key, head });
    }
  }, [isMovie, head, episodes, group, onPlay]);

  const handleToggleMovieWatched = useCallback(async () => {
    if (!isMovie) return;
    await markLocalMovieWatched(head, !movieWatchStatus.completed);
  }, [isMovie, head, movieWatchStatus.completed]);

  const handleDelete = useCallback(() => {
    if (confirmDelete) {
      onRemove(allEntries.map((e) => e.id));
      onClose();
    } else {
      setConfirmDelete(true);
    }
  }, [confirmDelete, allEntries, onRemove, onClose]);

  const currentSeasonEpisodes = seasonsMap.get(selectedSeason) || [];

  return (
    <div className="local-detail" onMouseLeave={() => setConfirmDelete(false)}>
      {/* Hero Section with Backdrop */}
      <div className="local-detail__hero">
        {backdropSrc && (
          <div
            className="local-detail__backdrop"
            style={{ backgroundImage: `url("${backdropSrc}")` }}
          />
        )}
        <div className="local-detail__backdrop-gradient" />

        {/* Top bar */}
        <div className="local-detail__top-bar">
          <button type="button" className="local-detail__back-btn" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            {t('back', 'Back')}
          </button>
        </div>

        {/* Hero Content */}
        <div className="local-detail__content">
          {/* Poster */}
          <div className="local-detail__poster-wrap">
            {posterSrc ? (
              <img src={posterSrc} alt={head.title} className="local-detail__poster-img" />
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1e1e1e', color: 'rgba(255,255,255,0.3)' }}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                  <polyline points="17 2 12 7 7 2" />
                </svg>
              </div>
            )}
          </div>

          {/* Main Info */}
          <div className="local-detail__main-info">
            {logoSrc ? (
              <img src={logoSrc} alt={head.title} className="local-detail__logo-img" />
            ) : (
              <h1 className="local-detail__title">{head.title}</h1>
            )}

            {/* Metadata Badges */}
            <div className="local-detail__meta-row">
              {head.year && <span>{head.year}</span>}
              {head.runtime && head.runtime > 0 && (
                <span>
                  {Math.floor(head.runtime / 60)}h {head.runtime % 60}m
                </span>
              )}
              {head.rating && head.rating > 0 && (
                <span className="local-detail__badge local-detail__badge--rating">
                  ★ {head.rating.toFixed(1)}
                </span>
              )}
              {head.resolution && (
                <span className="local-detail__badge">{head.resolution}</span>
              )}
              <span className="local-detail__badge">
                {isMovie ? t('movie', 'Movie') : `${episodes.length} ${t('episodes', 'Episodes')}`}
              </span>
            </div>

            {/* Plot / Overview */}
            {head.overview && (
              <p className="local-detail__plot">{head.overview}</p>
            )}

            {/* Actions Bar */}
            <div className="local-detail__actions">
              <button
                type="button"
                className="local-detail__play-btn"
                onClick={handlePrimaryPlay}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                {isMovie && movieWatchStatus.progressPercent > 0 && !movieWatchStatus.completed
                  ? t('resume', 'Resume')
                  : t('play', 'Play')}
              </button>

              {isMovie && (
                <button
                  type="button"
                  className="local-detail__action-btn"
                  onClick={handleToggleMovieWatched}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  {movieWatchStatus.completed
                    ? t('markUnwatched', 'Mark as unwatched')
                    : t('markWatched', 'Mark as watched')}
                </button>
              )}

              <button
                type="button"
                className="local-detail__action-btn"
                onClick={() => onFixMatch(allEntries)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" />
                </svg>
                {t('fixMatch', 'Fix match')}
              </button>

              <button
                type="button"
                className="local-detail__action-btn"
                onClick={handleOpenFolder}
                title={t('openFolder', 'Show in folder')}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                {t('showInFolder', 'Show in folder')}
              </button>

              <button
                type="button"
                className={`local-detail__action-btn ${confirmDelete ? 'danger' : ''}`}
                onClick={handleDelete}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                {confirmDelete ? t('confirmRemove', 'Click again to remove') : t('remove', 'Remove')}
              </button>
            </div>

            {/* Path Box */}
            <div className="local-detail__path-box">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                <polyline points="13 2 13 9 20 9" />
              </svg>
              <span>{head.path}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Series Seasons and Episodes */}
      {!isMovie && seasonsList.length > 0 && (
        <div className="local-detail__seasons-section">
          <div className="local-detail__episodes-header">
            <h3 className="local-detail__section-title">{t('episodes', 'Episodes')}</h3>

            {/* Season Selector Dropdown or Pills */}
            {seasonsList.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <select
                  className="local-detail__season-dropdown"
                  value={selectedSeason}
                  onChange={(e) => setSelectedSeason(Number(e.target.value))}
                >
                  {seasonsList.map((s) => (
                    <option key={s} value={s}>
                      {t('seasonNum', 'Season {{num}}', { num: s })} ({seasonsMap.get(s)?.length || 0})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Episodes Grid with Harbor-like rich cards */}
          <div className="local-detail__episodes-grid">
            {currentSeasonEpisodes.map((ep) => (
              <LocalEpisodeCard
                key={ep.id}
                episode={ep}
                seriesTitle={head.title}
                tmdbEpisode={seasonEpisodesMap.get(ep.episode ?? 1)}
                seriesBackdrop={backdropSrc}
                onPlay={(selectedEp) => onPlay(selectedEp, { key: group.key, head })}
              />
            ))}
          </div>
        </div>
      )}

      {/* Cast Section */}
      {cast.length > 0 && (
        <div className="local-detail__cast-section">
          <h3 className="local-detail__section-title">{t('cast', 'Cast')}</h3>
          <div className="local-detail__cast-scroll">
            {cast.map((c) => (
              <div key={c.id} className="local-detail__cast-card">
                <div className="local-detail__cast-img-wrap">
                  {c.profilePath ? (
                    <img src={c.profilePath} alt={c.name} className="local-detail__cast-img" loading="lazy" />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.3)', fontSize: '20px' }}>
                      👤
                    </div>
                  )}
                </div>
                <span className="local-detail__cast-name" title={c.name}>
                  {c.name}
                </span>
                <span className="local-detail__cast-char" title={c.character}>
                  {c.character}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
