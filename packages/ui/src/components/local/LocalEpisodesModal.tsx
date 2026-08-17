import { useState, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { LocalEntry } from '../../services/local-library/types';
import { episodeLabel } from '../../services/local-library/local-library';
import { useLocalEpisodeWatchStatus, markLocalEpisodeWatched } from '../../services/local-library/local-watch';

interface LocalEpisodesModalProps {
  head: LocalEntry;
  episodes: LocalEntry[];
  onClose: () => void;
  onPlayEpisode: (episode: LocalEntry) => void;
}

function LocalEpisodeRow({
  episode,
  seriesTitle,
  onPlay,
}: {
  episode: LocalEntry;
  seriesTitle: string;
  onPlay: (episode: LocalEntry) => void;
}) {
  const { t } = useTranslation('vod');
  const watchStatus = useLocalEpisodeWatchStatus(episode);
  const epTag = episodeLabel(episode) || (episode.episode != null ? `E${episode.episode}` : 'EP');

  const handleToggleWatched = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await markLocalEpisodeWatched(episode, seriesTitle, !watchStatus.completed);
  }, [episode, seriesTitle, watchStatus.completed]);

  return (
    <div className="local-ep-item" onClick={() => onPlay(episode)} style={{ cursor: 'pointer' }}>
      <div className="local-ep-item__left">
        <span className="local-ep-item__badge">{epTag}</span>
        <div className="local-ep-item__info">
          <span className="local-ep-item__title">
            {episode.title !== seriesTitle ? episode.title : `${epTag} · ${episode.filename}`}
          </span>
          <span className="local-ep-item__file">{episode.filename}</span>
          {watchStatus.progressPercent > 0 && !watchStatus.completed && (
            <div style={{ width: '100%', maxWidth: '200px', height: '3px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden', marginTop: '4px' }}>
              <div style={{ width: `${watchStatus.progressPercent}%`, height: '100%', background: 'var(--accent-primary, #00d4ff)' }} />
            </div>
          )}
        </div>
      </div>

      <div className="local-ep-item__right">
        {episode.resolution && (
          <span className="local-badge" style={{ position: 'static' }}>
            {episode.resolution}
          </span>
        )}

        <button
          type="button"
          className="local-btn local-btn--secondary"
          style={{ height: '30px', padding: '0 10px' }}
          onClick={handleToggleWatched}
          title={watchStatus.completed ? t('markUnwatched', 'Mark as unwatched') : t('markWatched', 'Mark as watched')}
        >
          {watchStatus.completed ? (
            <span style={{ color: 'var(--status-new, #2ecc71)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {t('watched', 'Watched')}
            </span>
          ) : (
            <span>{t('mark', 'Mark')}</span>
          )}
        </button>

        <button
          type="button"
          className="local-btn local-btn--primary"
          style={{ height: '30px', padding: '0 12px' }}
          onClick={(e) => {
            e.stopPropagation();
            onPlay(episode);
          }}
          title={t('play', 'Play')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          {t('play', 'Play')}
        </button>
      </div>
    </div>
  );
}

export const LocalEpisodesModal = memo(function LocalEpisodesModal({
  head,
  episodes,
  onClose,
  onPlayEpisode,
}: LocalEpisodesModalProps) {
  const { t } = useTranslation('vod');

  const posterRaw = head.poster || head.localArt?.poster;
  const posterSrc = posterRaw
    ? (posterRaw.startsWith('http://') || posterRaw.startsWith('https://') || posterRaw.startsWith('data:') || posterRaw.startsWith('asset:')
      ? posterRaw
      : convertFileSrc(posterRaw))
    : null;

  return (
    <div className="local-modal-overlay" onClick={onClose}>
      <div className="local-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="local-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            {posterSrc && (
              <img
                src={posterSrc}
                alt=""
                style={{ width: '48px', height: '68px', borderRadius: '8px', objectFit: 'cover' }}
              />
            )}
            <div>
              <h3 className="local-modal-title">{head.title}</h3>
              <p className="local-modal-subtitle">
                {episodes.length} {episodes.length === 1 ? t('episode', 'episode') : t('episodes', 'episodes')}
                {head.year ? ` · ${head.year}` : ''}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="local-modal-close"
            onClick={onClose}
            aria-label={t('close', 'Close')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="local-modal-body">
          {episodes.map((ep) => (
            <LocalEpisodeRow
              key={ep.id}
              episode={ep}
              seriesTitle={head.title}
              onPlay={onPlayEpisode}
            />
          ))}
        </div>
      </div>
    </div>
  );
});
