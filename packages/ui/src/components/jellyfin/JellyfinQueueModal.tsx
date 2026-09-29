import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { JellyfinQueueItem, VodPlayInfo } from '../../types/media';
import { jellyfinQueueItemLabel, resolveJellyfinQueuePosition } from '../../utils/jellyfinQueue';
import '../vod/PlaylistQueueModal.css';

/**
 * Overlay listing the Jellyfin play queue currently driving playback — i.e. the
 * playlist the page started playing from, in play order, with the playing item
 * highlighted and the next-up item marked. Jumping to a row plays that item and
 * keeps the same queue active, so prev/next continue through the playlist.
 *
 * Queue entries the page never opened arrive without metadata (the bridge only
 * has what the page fetched), so those are resolved once here from the API and
 * shown as their S/E numbers until the names land.
 */

interface JellyfinQueueModalProps {
  isOpen: boolean;
  onClose: () => void;
  vodInfo: VodPlayInfo | null;
  onPlayItem: (index: number) => void;
}

interface ResolvedDetails {
  name?: string;
  type?: string;
  indexNumber?: number | null;
  parentIndexNumber?: number | null;
  seriesName?: string;
}

/** Jellyfin item artwork for a queue row (same pattern as the details modal). */
function posterUrl(server: string, apiKey: string, itemId: string): string | undefined {
  if (!server || !apiKey || !itemId) return undefined;
  return `${server}/Items/${encodeURIComponent(itemId)}/Images/Primary?maxWidth=300&api_key=${encodeURIComponent(apiKey)}`;
}

export function JellyfinQueueModal({ isOpen, onClose, vodInfo, onPlayItem }: JellyfinQueueModalProps) {
  useTranslation();
  const server = (vodInfo?.jellyfinServerUrl || '').replace(/\/+$/, '');
  const apiKey = vodInfo?.jellyfinApiKey || '';
  const userId = vodInfo?.jellyfinUserId || '';
  const queue: JellyfinQueueItem[] = vodInfo?.jellyfinQueue || [];
  const position = resolveJellyfinQueuePosition(queue, vodInfo?.jellyfinItemId, vodInfo?.jellyfinQueueIndex);

  const [details, setDetails] = useState<Record<string, ResolvedDetails>>({});

  // Queue entries the bridge could not describe carry only an id. Resolve the
  // whole batch in one request the first time the overlay opens.
  const unresolvedIds = useMemo(
    () =>
      isOpen
        ? queue
            .filter((item) => !item.name && item.indexNumber == null)
            .map((item) => item.id)
            .filter(Boolean)
            .slice(0, 100)
        : [],
    [isOpen, queue],
  );
  const unresolvedKey = unresolvedIds.join(',');

  useEffect(() => {
    if (!isOpen || !unresolvedKey || !server || !apiKey || !userId) return;
    let cancelled = false;
    const url =
      `${server}/Users/${encodeURIComponent(userId)}/Items` +
      `?Ids=${encodeURIComponent(unresolvedKey)}&Fields=SeriesInfo`;
    fetch(url, { headers: { 'X-Emby-Token': apiKey } })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body || !Array.isArray(body.Items)) return;
        const next: Record<string, ResolvedDetails> = {};
        for (const item of body.Items) {
          const id = String(item?.Id || '').replace(/-/g, '');
          if (!id) continue;
          next[id] = {
            name: item.Name || '',
            type: item.Type || '',
            indexNumber: item.IndexNumber != null ? item.IndexNumber : null,
            parentIndexNumber: item.ParentIndexNumber != null ? item.ParentIndexNumber : null,
            seriesName: item.SeriesName || '',
          };
        }
        setDetails((prev) => ({ ...prev, ...next }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen, unresolvedKey, server, apiKey, userId]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const label = (item: JellyfinQueueItem) => {
    const resolved = details[item.id];
    const merged: JellyfinQueueItem = resolved ? { ...item, ...resolved } : item;
    return jellyfinQueueItemLabel(merged, i18n.t('player:loading'));
  };

  const subLabel = (item: JellyfinQueueItem) => {
    const resolved = details[item.id];
    const merged: JellyfinQueueItem = resolved ? { ...item, ...resolved } : item;
    const series = (merged.seriesName || '').trim();
    const se =
      merged.indexNumber != null
        ? merged.parentIndexNumber != null
          ? `S${merged.parentIndexNumber} E${merged.indexNumber}`
          : `E${merged.indexNumber}`
        : '';
    const kind = (merged.type || '').toLowerCase() === 'movie' ? i18n.t('vod:movie') : i18n.t('vod:series');
    return [series || (se ? '' : kind), se].filter(Boolean).join(' · ');
  };

  return createPortal(
    <div className="playlist-queue-overlay" onClick={onClose}>
      <div className="playlist-queue-modal" onClick={(e) => e.stopPropagation()}>
        <div className="playlist-queue-modal__header">
          <h3 className="playlist-queue-modal__title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            {vodInfo?.jellyfinQueueName || i18n.t('player:playlistQueue')}
            {queue.length > 0 && <span className="playlist-queue-modal__count">{queue.length}</span>}
          </h3>
          {position && (
            <span className="playlist-queue-modal__position" title={i18n.t('player:currentlyPlaying')}>
              {i18n.t('player:playingXofY', { current: position.index + 1, total: position.total })}
            </span>
          )}
          <button
            className="playlist-queue-modal__close"
            onClick={onClose}
            aria-label={i18n.t('common:close')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="playlist-queue-modal__body">
          {queue.length === 0 ? (
            <p className="playlist-queue-modal__empty">{i18n.t('vod:noContent')}</p>
          ) : (
            <div className="playlist-queue-modal__list">
              {queue.map((item, index) => {
                const isCurrent = index === position?.index;
                const isNext = !!position && index === position.index + 1;
                const poster = posterUrl(server, apiKey, item.rawId || item.id);
                const text = label(item);
                return (
                  <div
                    key={`${item.id}-${index}`}
                    className={`playlist-queue-item ${isCurrent ? 'is-current' : ''} ${isNext ? 'is-next' : ''}`}
                  >
                    <button
                      type="button"
                      className="playlist-queue-item__main"
                      onClick={() => onPlayItem(index)}
                      title={i18n.t('player:jumpToItem')}
                    >
                      {poster ? (
                        <img src={poster} alt="" className="playlist-queue-item__poster" loading="lazy" />
                      ) : (
                        <div className="playlist-queue-item__poster playlist-queue-item__poster--placeholder">
                          {text.charAt(0)}
                        </div>
                      )}
                      <div className="playlist-queue-item__details">
                        <span className="playlist-queue-item__title">{text}</span>
                        <span className="playlist-queue-item__sub">{subLabel(item)}</span>
                      </div>
                      {isCurrent && (
                        <span className="playlist-queue-item__now">{i18n.t('player:currentlyPlaying')}</span>
                      )}
                      {isNext && <span className="playlist-queue-item__next">{i18n.t('player:nextUp')}</span>}
                    </button>
                    <div className="playlist-queue-item__actions">
                      <span className="playlist-queue-item__num">{index + 1}</span>
                      {isCurrent ? (
                        <span
                          className="playlist-queue-item__playing-dot"
                          title={i18n.t('player:currentlyPlaying')}
                        />
                      ) : (
                        <button
                          type="button"
                          className="playlist-queue-item__icon-btn"
                          onClick={() => onPlayItem(index)}
                          title={i18n.t('player:jumpToItem')}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="playlist-queue-modal__footer">{i18n.t('player:clickToJump')}</div>
      </div>
    </div>,
    document.body,
  );
}
