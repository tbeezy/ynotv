import { useState, useMemo, useEffect, useRef, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { VirtualList } from '../common/VirtualList';
import type { LocalGroup } from '../../services/local-library/types';
import { reviewGroupIds, reviewGroupKey } from '../../services/local-library/review-groups';

interface ReviewUnmatchedModalProps {
  groups: LocalGroup[];
  /**
   * Review-group keys the identify flow has finished with (resolved, skipped or
   * removed). A cancelled flow reports nothing, so its row stays listed.
   */
  handledKeys: Set<string>;
  onClose: () => void;
  /** Queue a match review for every given group, one after another. */
  onMatch: (groups: LocalGroup[]) => void;
  /** Open the match review for a single row. */
  onMatchOne: (group: LocalGroup) => void;
  onRemove: (ids: string[]) => void;
  onSkip: (ids: string[]) => void;
}

/** Longest common parent directory of a set of paths (the series folder). */
function commonFolder(paths: string[]): string {
  let common = (paths[0] ?? '').replace(/\\/g, '/');
  if (!common) return '';
  for (const raw of paths) {
    const p = raw.replace(/\\/g, '/');
    while (common && !p.toLowerCase().startsWith(common.toLowerCase())) {
      const i = common.lastIndexOf('/');
      if (i <= 0) {
        common = '';
        break;
      }
      common = common.slice(0, i);
    }
    if (!common) break;
  }
  return common;
}

/** The folder a review unit belongs to (series root for shows, parent for movies). */
function groupFolder(g: LocalGroup): string {
  if (g.kind === 'movie') {
    const p = g.entry.path.replace(/\\/g, '/');
    const i = p.lastIndexOf('/');
    return i > 0 ? p.slice(0, i) : p;
  }
  return commonFolder(g.episodes.map((e) => e.path));
}

/**
 * Review step for unmatched items. Since folders are scanned as series (one
 * TMDB lookup per show), review is per SERIES FOLDER — one row per unmatched
 * series (or movie), never per file — so a 500-episode folder shows as a
 * single row. The user picks which series to match (Identify) or remove.
 */
export const ReviewUnmatchedModal = memo(function ReviewUnmatchedModal({
  groups,
  handledKeys,
  onClose,
  onMatch,
  onMatchOne,
  onRemove,
  onSkip,
}: ReviewUnmatchedModalProps) {
  const { t } = useTranslation('vod');
  // Local working list: removing/skipping a row drops it immediately so the
  // user moves on to the next item; the parent's `groups` snapshot only
  // changes when the modal is reopened.
  const [working, setWorking] = useState<LocalGroup[]>(groups);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(groups.map(reviewGroupKey)),
  );
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return working;
    return working.filter((g) => {
      const title = (g.kind === 'movie' ? g.entry.title : g.head.title || '').toLowerCase();
      const folder = groupFolder(g).toLowerCase();
      return title.includes(q) || folder.includes(q);
    });
  }, [working, filter]);
  const hasFilter = filter.trim().length > 0;

  const toggle = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selected = useMemo(
    () => working.filter((g) => selectedKeys.has(reviewGroupKey(g))),
    [working, selectedKeys],
  );

  // Drop rows after a per-row or batch remove/skip; prune their keys from the
  // selection. Matching never drops here — a matched row leaves the list only
  // when the parent reports it as handled (see the `handledKeys` effect below),
  // so cancelling the identify flow leaves the row in place.
  const dropKeys = (keys: Set<string>) => {
    setWorking((prev) => prev.filter((g) => !keys.has(reviewGroupKey(g))));
    setSelectedKeys((prev) => {
      const pruned = new Set(prev);
      for (const k of keys) pruned.delete(k);
      return pruned;
    });
  };

  // Adopt the rows the parent reported as handled. The parent reports a group
  // only once its identify flow truly ended (resolved, skipped or removed), so a
  // cancelled flow leaves its row — and everything still queued behind it — in
  // the list for another attempt.
  useEffect(() => {
    if (handledKeys.size === 0) return;
    setWorking((prev) => prev.filter((g) => !handledKeys.has(reviewGroupKey(g))));
    setSelectedKeys((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const k of handledKeys) {
        if (next.delete(k)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [handledKeys]);

  // Close the modal once every review unit has been handled.
  useEffect(() => {
    if (working.length === 0 && groups.length > 0) {
      onClose();
    }
  }, [working, groups, onClose]);

  const removeGroup = (g: LocalGroup) => {
    const ids = reviewGroupIds(g);
    if (ids.length > 0) onRemove(ids);
    dropKeys(new Set([reviewGroupKey(g)]));
  };

  const skipGroup = (g: LocalGroup) => {
    const ids = reviewGroupIds(g);
    if (ids.length > 0) onSkip(ids);
    dropKeys(new Set([reviewGroupKey(g)]));
  };

  const removeSelected = () => {
    const ids = selected.flatMap(reviewGroupIds);
    if (ids.length > 0) onRemove(ids);
    dropKeys(selectedKeys);
  };

  const skipSelected = () => {
    const ids = selected.flatMap(reviewGroupIds);
    if (ids.length > 0) onSkip(ids);
    dropKeys(selectedKeys);
  };

  // Review the match for one row without leaving the list: the parent opens the
  // identify modal above it. The row is dropped once the parent reports it as
  // handled, so cancelling the review leaves it listed.
  const matchGroup = (g: LocalGroup) => {
    onMatchOne(g);
  };

  // Review the match for every checked row, one at a time. The parent queues the
  // reviews and the list stays open underneath; rows leave as they are reported
  // handled, and anything cancelled — checked or not — is still there.
  const matchSelected = () => {
    if (selected.length === 0) return;
    onMatch(selected);
  };

  return (
    // No overlay-click-to-close: dismissing the review list mid-way would
    // discard the user's place, and mis-clicks are common around modals.
    <div className="local-modal-overlay">
      <div
        className="local-modal-content local-modal-content--review"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="local-modal-header">
          <div>
            <h3 className="local-modal-title">
              {t('reviewUnmatchedTitle', 'Review unmatched items')}
            </h3>
            <p className="local-modal-subtitle">
              {t('reviewUnmatchedSubtitle', 'One row per series or movie — match it, or remove it from your library.')}
            </p>
          </div>
          <button type="button" className="local-modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="local-modal-body">
          {/* Filter input: narrow the list to a title or folder */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('filterFiles', 'Filter by title or folder...')}
              className="local-toolbar__search-input"
              style={{ height: '38px', borderRadius: '10px', paddingLeft: '36px' }}
            />
            <span className="local-toolbar__search-icon" style={{ left: '11px' }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
          </div>

          {/* Selection toolbar */}
          <div className="local-batch-toolbar">
            <span className="local-batch-toolbar__count">
              {selectedKeys.size} {t('selected', 'selected')}
              {hasFilter && filtered.length !== working.length && (
                <span className="local-batch-toolbar__matching">
                  · {t('matching', '{{count}} matching', { count: filtered.length })}
                </span>
              )}
            </span>
            <div className="local-batch-toolbar__actions">
              {hasFilter && (
                <button
                  type="button"
                  className="local-btn local-btn--primary"
                  onClick={() => setSelectedKeys(new Set(filtered.map(reviewGroupKey)))}
                  disabled={filtered.length === 0}
                >
                  {t('selectFiltered', 'Select filtered')}
                </button>
              )}
              <button
                type="button"
                className="local-btn local-btn--secondary"
                onClick={() => setSelectedKeys(new Set(working.map(reviewGroupKey)))}
                disabled={selectedKeys.size === working.length}
              >
                {t('selectAll', 'Select All')}
              </button>
              <button
                type="button"
                className="local-btn local-btn--secondary"
                onClick={() => setSelectedKeys(new Set())}
                disabled={selectedKeys.size === 0}
              >
                {t('selectNone', 'Select None')}
              </button>
            </div>
          </div>

          {/* Virtualized list of review units (one per series/movie) */}
          <div ref={listRef} className="local-batch-list" style={{ height: 'min(45vh, 400px)' }}>
            <VirtualList
              scrollRef={listRef}
              items={filtered}
              estimateItemHeight={56}
              getKey={(g) => reviewGroupKey(g)}
              renderItem={(g) => {
                const key = reviewGroupKey(g);
                const checked = selectedKeys.has(key);
                const isMovie = g.kind === 'movie';
                const title = isMovie ? g.entry.title : g.head.title;
                const count = isMovie ? 1 : g.episodes.length;
                const folder = groupFolder(g);
                return (
                  <div
                    className={`local-batch-row${checked ? ' selected' : ''}`}
                    onClick={() => toggle(key)}
                  >
                    <span className={`local-batch-checkbox${checked ? ' checked' : ''}`}>
                      {checked && (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    <div className="local-batch-row__info">
                      <span className="local-batch-row__title" title={title}>
                        {title || (isMovie ? g.entry.filename : g.head.filename)}
                      </span>
                      <span className="local-batch-row__meta">
                        {isMovie
                          ? t('movie', 'Movie')
                          : `${count} ${count === 1 ? t('episode', 'episode') : t('episodes', 'episodes')}`}
                        {folder ? ` · ${folder}` : ''}
                      </span>
                    </div>
                    {/* Per-row actions: match this item, skip it, or remove it from the library */}
                    <div className="local-batch-row__actions">
                      <button
                        type="button"
                        className="local-row-btn local-row-btn--match"
                        onClick={(e) => {
                          e.stopPropagation();
                          matchGroup(g);
                        }}
                        title={t('reviewMatchRow', 'Fix the match for this item')}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" />
                        </svg>
                        {t('fixMatch', 'Fix match')}
                      </button>
                      <button
                        type="button"
                        className="local-row-btn local-row-btn--skip"
                        onClick={(e) => {
                          e.stopPropagation();
                          skipGroup(g);
                        }}
                        title={t('reviewSkipRow', 'Skip matching this item')}
                      >
                        {t('skip', 'Skip')}
                      </button>
                      <button
                        type="button"
                        className="local-row-btn local-row-btn--remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeGroup(g);
                        }}
                        title={t('reviewRemoveRow', 'Remove this item from the library')}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                        {t('common:remove', 'Remove')}
                      </button>
                    </div>
                  </div>
                );
              }}
              overscan={4}
            />
          </div>
        </div>

        {/* Footer actions: fix the match for each selected item, or skip /
            remove them. The batch match lives with the other batch actions. */}
        <div className="local-modal-footer">
          <button
            type="button"
            className="local-btn local-btn--secondary"
            style={{ color: '#ef4444' }}
            onClick={removeSelected}
            disabled={selectedKeys.size === 0}
          >
            {t('removeSelected', 'Remove selected')}
          </button>
          <button
            type="button"
            className="local-btn local-btn--secondary"
            onClick={skipSelected}
            disabled={selectedKeys.size === 0}
          >
            {t('skipSelected', 'Skip selected')}
          </button>
          <button
            type="button"
            className="local-btn local-btn--primary"
            onClick={matchSelected}
            disabled={selectedKeys.size === 0}
          >
            {t('fixMatchSelected', 'Fix match selected')}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="local-btn local-btn--secondary" onClick={onClose}>
            {t('common:cancel', 'Cancel')}
          </button>
        </div>
      </div>
    </div>
  );
});
