import { useState, useCallback, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { LocalEntry } from '../../services/local-library/types';
import { episodeLabel, updateLocalEntries } from '../../services/local-library/local-library';
import { useLocalEpisodeWatchStatus, markLocalEpisodeWatched } from '../../services/local-library/local-watch';
import { EpisodeContextMenu } from './EpisodeContextMenu';
import { EditEpisodeMetadataModal } from './EditEpisodeMetadataModal';

interface LocalEpisodesModalProps {
  head: LocalEntry;
  episodes: LocalEntry[];
  onClose: () => void;
  onPlayEpisode: (episode: LocalEntry) => void;
  onFixMatch?: (episode: LocalEntry) => void;
}

function LocalEpisodeRow({
  episode,
  seriesTitle,
  onPlay,
  onContextMenu,
}: {
  episode: LocalEntry;
  seriesTitle: string;
  onPlay: (episode: LocalEntry) => void;
  onContextMenu: (e: React.MouseEvent, episode: LocalEntry) => void;
}) {
  const { t } = useTranslation('vod');
  const watchStatus = useLocalEpisodeWatchStatus(episode);
  const epTag = episodeLabel(episode) || (episode.episode != null ? `E${episode.episode}` : 'EP');

  const handleToggleWatched = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await markLocalEpisodeWatched(episode, seriesTitle, !watchStatus.completed);
  }, [episode, seriesTitle, watchStatus.completed]);

  return (
    <div
      className="local-ep-item"
      onClick={() => onPlay(episode)}
      onContextMenu={(e) => onContextMenu(e, episode)}
      style={{ cursor: 'pointer' }}
    >
      <div className="local-ep-item__left">
        <span className="local-ep-item__badge">{epTag}</span>
        <div className="local-ep-item__info">
          <span
            className="local-ep-item__title"
            title={episode.title !== seriesTitle ? episode.title : `${epTag} · ${episode.filename}`}
          >
            {episode.title !== seriesTitle ? episode.title : `${epTag} · ${episode.filename}`}
          </span>
          <span className="local-ep-item__file" title={episode.path || episode.filename}>
            {episode.filename}
          </span>
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
  onFixMatch,
}: LocalEpisodesModalProps) {
  const { t } = useTranslation('vod');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: LocalEntry } | null>(null);
  const [editTarget, setEditTarget] = useState<LocalEntry | null>(null);

  const handleCloseContextMenu = useCallback(() => setCtxMenu(null), []);

  const handleEpisodeContextMenu = useCallback((e: React.MouseEvent, entry: LocalEntry) => {
    e.preventDefault();
    setEditTarget(null);
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  const handleEditSave = useCallback(
    (patch: { season: number | null; episode: number; title: string }) => {
      if (!editTarget) return;
      updateLocalEntries([editTarget.id], { ...patch, metadataLocked: true });
      setEditTarget(null);
    },
    [editTarget],
  );

  const handleFixMatch = useCallback(
    (entry: LocalEntry) => {
      setCtxMenu(null);
      onFixMatch?.(entry);
    },
    [onFixMatch],
  );

  // Close context menu or edit modal on Escape key
  useEffect(() => {
    if (!ctxMenu && !editTarget) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (ctxMenu) setCtxMenu(null);
        else if (editTarget) setEditTarget(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [ctxMenu, editTarget]);

  // Auto-close if all episodes have been moved or removed
  useEffect(() => {
    if (episodes.length === 0) {
      onClose();
    }
  }, [episodes.length, onClose]);

  const posterRaw = head.poster || head.localArt?.poster;
  const posterSrc = posterRaw
    ? (posterRaw.startsWith('http://') || posterRaw.startsWith('https://') || posterRaw.startsWith('data:') || posterRaw.startsWith('asset:')
      ? posterRaw
      : convertFileSrc(posterRaw))
    : null;

  return (
    <div className="local-modal-overlay" onClick={onClose}>
      <div
        className="local-modal-content local-modal-content--episodes"
        onClick={(e) => e.stopPropagation()}
      >
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
              onContextMenu={handleEpisodeContextMenu}
            />
          ))}
        </div>

        {/* Right-click context menu on an episode item */}
        {ctxMenu && (
          <EpisodeContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            entry={ctxMenu.entry}
            onClose={handleCloseContextMenu}
            onEdit={(entry) => setEditTarget(entry)}
            onFixMatch={handleFixMatch}
          />
        )}

        {/* Edit episode metadata modal */}
        {editTarget && (
          <EditEpisodeMetadataModal
            entry={editTarget}
            onClose={() => setEditTarget(null)}
            onSave={handleEditSave}
          />
        )}
      </div>
    </div>
  );
});
