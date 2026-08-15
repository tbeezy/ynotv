import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { SportsTeam } from '@ynotv/core';
import { db, type StoredChannel, type TeamChannelLink } from '../../db';
import { getLeagueTeams } from '../../services/sports';
import {
  searchChannelsForLink,
  getTeamChannelSuggestions,
  splitTeamName,
  INDIVIDUAL_SPORT_LEAGUES,
  type TeamLinkSuggestion,
  type TeamChannelCandidate,
} from '../../services/sports/teamChannelMatcher';
import { ALL_LEAGUES, useSportsSettingsStore } from '../../stores/sportsSettingsStore';
import {
  useTeamChannelLinksStore,
  getTeamLinks,
} from '../../stores/teamChannelLinksStore';
import {
  AutoLinkSettingsModal,
  type SourceOption,
  type CategoryOption,
} from './AutoLinkSettingsModal';
import {
  useLeagueAutoLinkConfigStore,
  type LeagueAutoLinkConfig,
} from '../../stores/leagueAutoLinkConfigStore';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import './TeamChannelSettings.css';

function parseCategoryIds(raw: string | string[] | number[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* not JSON */
  }
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return [String(raw)];
}

function getChannelCategoryName(ch: StoredChannel, categoriesMap: Map<string, string>): string | undefined {
  const catIds = parseCategoryIds(ch.category_ids);
  for (const cid of catIds) {
    if (ch.source_id) {
      const name = categoriesMap.get(`${ch.source_id}:${cid}`);
      if (name) return name;
    }
    const fallbackName = categoriesMap.get(cid);
    if (fallbackName) return fallbackName;
  }
  return undefined;
}

function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h} 65% 40%)`;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function TeamLogo({ team }: { team: SportsTeam }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [team.logo]);

  if (team.logo && !failed) {
    return (
      <img
        src={team.logo}
        alt={team.name}
        className="tcs-team-logo"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className="tcs-team-logo tcs-team-logo-fallback"
      style={{ background: stringToColor(team.name) }}
    >
      {getInitials(team.name)}
    </div>
  );
}

function ChannelIcon({ icon, name }: { icon?: string; name: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [icon]);

  if (icon && !failed) {
    return (
      <img
        src={icon}
        alt=""
        className="tcs-channel-icon"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="tcs-channel-icon tcs-channel-icon-fallback">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="20" height="15" x="2" y="7" rx="2" ry="2" />
        <polyline points="17 2 12 7 7 2" />
      </svg>
    </div>
  );
}

// ─── Focused Channel Selection Modal (Multi-Channel / Backup aware) ──────────

interface ChannelPickerDialogProps {
  isOpen: boolean;
  team: SportsTeam | null;
  leagueId: string;
  existingTeamLinks: TeamChannelLink[];
  sourcesMap: Map<string, string>;
  categoriesMap: Map<string, string>;
  onSelectChannel: (team: SportsTeam, channel: StoredChannel, score?: number) => void;
  onUnlinkChannel: (team: SportsTeam, streamId: string) => void;
  onSetPrimary: (team: SportsTeam, streamId: string) => void;
  onUnlinkAll: (team: SportsTeam) => void;
  onClose: () => void;
}

function ChannelPickerDialog({
  isOpen,
  team,
  leagueId,
  existingTeamLinks,
  sourcesMap,
  categoriesMap,
  onSelectChannel,
  onUnlinkChannel,
  onSetPrimary,
  onUnlinkAll,
  onClose,
}: ChannelPickerDialogProps) {
  const { t } = useTranslation('sports');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<StoredChannel[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [suggestions, setSuggestions] = useState<TeamChannelCandidate[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen || !team) {
      setSearchQuery('');
      setSearchResults([]);
      setSuggestions([]);
      return;
    }

    // Auto-focus search input
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 50);

    // Load candidate suggestions for this specific team, honoring the league's
    // configured match strategy and source/category scope.
    let cancelled = false;
    setLoadingSuggestions(true);
    (async () => {
      await useLeagueAutoLinkConfigStore.getState().ensureLoaded();
      if (cancelled) return [];
      return getTeamChannelSuggestions(team, useLeagueAutoLinkConfigStore.getState().getConfig(leagueId));
    })()
      .then((candidates) => {
        if (!cancelled) setSuggestions(candidates);
      })
      .catch((err) => {
        console.error('[TeamChannelSettings] Failed to fetch team suggestions:', err);
      })
      .finally(() => {
        if (!cancelled) setLoadingSuggestions(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, team, leagueId]);

  // Debounced search
  useEffect(() => {
    if (!isOpen || !searchQuery.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    const id = window.setTimeout(async () => {
      try {
        const res = await searchChannelsForLink(searchQuery, 40);
        if (!cancelled) setSearchResults(res);
      } catch (err) {
        console.error('[TeamChannelSettings] Search failed:', err);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [isOpen, searchQuery]);

  if (!isOpen || !team) return null;

  const { city, nickname } = splitTeamName(team.name);
  const linkedStreamIdMap = new Map(existingTeamLinks.map((l, idx) => [l.stream_id, idx]));

  return createPortal(
    <div className="tcs-picker-dialog-overlay" onClick={onClose}>
      <div
        className="tcs-picker-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="tcs-picker-dialog-header">
          <div className="tcs-picker-dialog-team">
            <TeamLogo team={team} />
            <div>
              <h3 className="tcs-picker-dialog-team-name">
                {city && <span className="tcs-team-city-prefix">{city} </span>}
                {nickname}
              </h3>
              <div className="tcs-picker-dialog-badges-row">
                <span className="tcs-picker-dialog-league-badge">{leagueId.toUpperCase()}</span>
                {existingTeamLinks.length > 0 && (
                  <span className="tcs-picker-dialog-count-badge">
                    {existingTeamLinks.length === 1
                      ? t('oneChannelLinked')
                      : t('channelsLinkedSummary', { count: existingTeamLinks.length, backups: existingTeamLinks.length - 1 })}
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            className="tcs-modal-close"
            onClick={onClose}
            aria-label={i18n.t('common:close')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Current Linked Channels Drawer / List */}
        {existingTeamLinks.length > 0 && !searchQuery.trim() && (
          <div className="tcs-picker-linked-section">
            <div className="tcs-picker-section-title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="20" height="15" x="2" y="7" rx="2" ry="2" />
                <polyline points="17 2 12 7 7 2" />
              </svg>
              <span>{t('currentChannels', { count: existingTeamLinks.length })}</span>
            </div>
            <div className="tcs-picker-linked-list">
              {existingTeamLinks.map((l, idx) => {
                const isPrimary = idx === 0;
                const sourceName = l.source_id ? sourcesMap.get(l.source_id) : undefined;

                return (
                  <div key={l.stream_id} className={`tcs-picker-linked-item ${isPrimary ? 'primary' : 'backup'}`}>
                    <div className="tcs-picker-linked-item-left">
                      <span className={`tcs-priority-pill ${isPrimary ? 'primary' : 'backup'}`}>
                        {isPrimary ? t('primaryChannel') : t('backupChannel', { num: idx })}
                      </span>
                      <span className="tcs-picker-linked-name">{l.channel_name}</span>
                      {sourceName && <span className="tcs-source-badge">{sourceName}</span>}
                    </div>

                    <div className="tcs-picker-linked-item-actions">
                      {!isPrimary && (
                        <button
                          className="tcs-btn-make-primary-chip"
                          onClick={() => onSetPrimary(team, l.stream_id)}
                          title={t('makePrimary')}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="18 15 12 9 6 15" />
                          </svg>
                          <span>{t('makePrimary')}</span>
                        </button>
                      )}
                      <button
                        className="tcs-btn-remove-stream"
                        onClick={() => onUnlinkChannel(team, l.stream_id)}
                        title={t('removeChannel')}
                        aria-label={t('removeChannel')}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Search Input */}
        <div className="tcs-picker-dialog-search-wrap">
          <div className="tcs-search-box">
            <svg className="tcs-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={searchInputRef}
              className="tcs-search-input"
              type="text"
              placeholder={t('channelSearchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="tcs-search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
            {isSearching && <span className="tcs-spinner-small" />}
          </div>
        </div>

        {/* Modal Body */}
        <div className="tcs-picker-dialog-body">
          {/* Top Suggested Channel Matches */}
          {!searchQuery.trim() && (
            <div className="tcs-picker-section">
              <div className="tcs-picker-section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                {t('suggestedChannels')}
              </div>

              {loadingSuggestions ? (
                <div className="tcs-picker-loading-state">
                  <span className="tcs-spinner-small" />
                  <span>{t('loadingMatchSuggestions')}</span>
                </div>
              ) : suggestions.length === 0 ? (
                <div className="tcs-picker-no-suggestions">
                  <span>{t('noAutomatedMatches')}</span>
                </div>
              ) : (
                <div className="tcs-picker-channels-list">
                  {suggestions.map((item) => {
                    const ch = item.channel;
                    const linkedIdx = linkedStreamIdMap.get(ch.stream_id);
                    const isAlreadyLinked = linkedIdx !== undefined;
                    const sourceName = ch.source_id ? sourcesMap.get(ch.source_id) : undefined;
                    const categoryName = getChannelCategoryName(ch, categoriesMap);
                    const matchPercent = Math.round(item.score * 100);

                    return (
                      <button
                        key={ch.stream_id}
                        className={`tcs-channel-result-card ${isAlreadyLinked ? 'active' : ''}`}
                        onClick={() => {
                          if (!isAlreadyLinked) {
                            onSelectChannel(team, ch, item.score);
                          }
                        }}
                      >
                        <ChannelIcon icon={ch.stream_icon} name={ch.alias || ch.name} />
                        <div className="tcs-channel-result-info">
                          <div className="tcs-channel-result-name-row">
                            <span className="tcs-channel-result-name">{ch.alias || ch.name}</span>
                            <span className={`tcs-match-badge ${matchPercent >= 85 ? 'high' : 'medium'}`}>
                              {t('confidenceMatch', { percent: matchPercent })}
                            </span>
                          </div>
                          <div className="tcs-channel-result-meta">
                            {sourceName && <span className="tcs-source-badge">{sourceName}</span>}
                            {categoryName && <span className="tcs-category-badge">{categoryName}</span>}
                            {ch.channel_num !== undefined && (
                              <span className="tcs-meta-tag">Ch. {ch.channel_num}</span>
                            )}
                          </div>
                        </div>
                        <div className="tcs-channel-result-action">
                          {isAlreadyLinked ? (
                            <span className="tcs-badge-current">
                              {linkedIdx === 0 ? t('primaryChannel') : t('backupChannel', { num: linkedIdx })}
                            </span>
                          ) : existingTeamLinks.length === 0 ? (
                            <span className="tcs-btn-select-chip">{t('linkChannel')}</span>
                          ) : (
                            <span className="tcs-btn-select-chip backup">{t('addBackupChannel')}</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Search Results */}
          {searchQuery.trim().length > 0 && (
            <div className="tcs-picker-section">
              <div className="tcs-picker-section-title">
                {t('allChannels')} ({searchResults.length})
              </div>

              {isSearching ? (
                <div className="tcs-picker-loading-state">
                  <span className="tcs-spinner-small" />
                  <span>{t('searchingChannels')}</span>
                </div>
              ) : searchResults.length === 0 ? (
                <div className="tcs-picker-empty-results">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.3-4.3" />
                  </svg>
                  <p className="tcs-empty-title">{t('noChannelsFound')}</p>
                  <p className="tcs-empty-desc">{t('noChannelsFoundTip')}</p>
                </div>
              ) : (
                <div className="tcs-picker-channels-list">
                  {searchResults.map((ch) => {
                    const linkedIdx = linkedStreamIdMap.get(ch.stream_id);
                    const isAlreadyLinked = linkedIdx !== undefined;
                    const sourceName = ch.source_id ? sourcesMap.get(ch.source_id) : undefined;
                    const categoryName = getChannelCategoryName(ch, categoriesMap);

                    return (
                      <button
                        key={ch.stream_id}
                        className={`tcs-channel-result-card ${isAlreadyLinked ? 'active' : ''}`}
                        onClick={() => {
                          if (!isAlreadyLinked) {
                            onSelectChannel(team, ch, 1);
                          }
                        }}
                      >
                        <ChannelIcon icon={ch.stream_icon} name={ch.alias || ch.name} />
                        <div className="tcs-channel-result-info">
                          <div className="tcs-channel-result-name-row">
                            <span className="tcs-channel-result-name">{ch.alias || ch.name}</span>
                          </div>
                          <div className="tcs-channel-result-meta">
                            {sourceName && <span className="tcs-source-badge">{sourceName}</span>}
                            {categoryName && <span className="tcs-category-badge">{categoryName}</span>}
                            {ch.channel_num !== undefined && (
                              <span className="tcs-meta-tag">Ch. {ch.channel_num}</span>
                            )}
                          </div>
                        </div>
                        <div className="tcs-channel-result-action">
                          {isAlreadyLinked ? (
                            <span className="tcs-badge-current">
                              {linkedIdx === 0 ? t('primaryChannel') : t('backupChannel', { num: linkedIdx })}
                            </span>
                          ) : existingTeamLinks.length === 0 ? (
                            <span className="tcs-btn-select-chip">{t('linkChannel')}</span>
                          ) : (
                            <span className="tcs-btn-select-chip backup">{t('addBackupChannel')}</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="tcs-picker-dialog-footer">
          {existingTeamLinks.length > 0 ? (
            <button
              className="tcs-btn-unlink-danger"
              onClick={() => {
                onUnlinkAll(team);
                onClose();
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
              {t('unlinkAll')}
            </button>
          ) : (
            <div />
          )}

          <button className="tcs-btn-secondary" onClick={onClose}>
            {i18n.t('common:done')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Drag-to-Reorder Linked Channel List (per team) ──────────────────────────

function SortableTeamChannelRow({
  link,
  num,
  isPrimary,
  sourceName,
  dropIndicator,
  onMakePrimary,
  onRemove,
}: {
  link: TeamChannelLink;
  num: number;
  isPrimary: boolean;
  sourceName?: string;
  dropIndicator: 'above' | 'below' | null;
  onMakePrimary: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('sports');
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: link.stream_id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 99 : 1,
    touchAction: 'none',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`tcs-team-channel-row ${isPrimary ? 'primary' : 'backup'}${isDragging ? ' dragging' : ''}${dropIndicator ? ` drop-${dropIndicator}` : ''}`}
    >
      <div className="tcs-team-channel-main">
        <span className={`tcs-priority-tag ${isPrimary ? 'primary' : 'backup'}`}>
          {isPrimary ? t('primaryChannel') : t('backupChannel', { num })}
        </span>
        <span className="tcs-team-channel-title" title={link.channel_name}>
          {link.channel_name}
        </span>
        {sourceName && <span className="tcs-source-badge">{sourceName}</span>}
      </div>

      <div className="tcs-team-channel-row-actions">
        {!isPrimary && (
          <button
            className="tcs-btn-row-action"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onMakePrimary}
            title={t('makePrimary')}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
        )}
        <button
          className="tcs-btn-row-action delete"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onRemove}
          title={t('removeChannel')}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function TeamChannelLinksSortable({
  links,
  leagueId,
  team,
  sourcesMap,
  onSetPrimary,
  onUnlinkChannel,
  onReorder,
}: {
  links: TeamChannelLink[];
  leagueId: string;
  team: SportsTeam;
  sourcesMap: Map<string, string>;
  onSetPrimary: (team: SportsTeam, streamId: string) => void;
  onUnlinkChannel: (team: SportsTeam, streamId: string) => void;
  onReorder: (leagueId: string, teamId: string, orderedStreamIds: string[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const ids = useMemo(() => links.map((l) => l.stream_id), [links]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (event.over && event.active.id !== event.over.id) {
      setOverId(String(event.over.id));
    } else {
      setOverId(null);
    }
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      setOverId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = ids.findIndex((id) => id === active.id);
      const newIndex = ids.findIndex((id) => id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      onReorder(leagueId, team.id, arrayMove(ids, oldIndex, newIndex));
    },
    [ids, leagueId, team.id, onReorder]
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverId(null);
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="tcs-team-channels-list">
          {links.map((l, idx) => {
            const isPrimary = idx === 0;
            const sourceName = l.source_id ? sourcesMap.get(l.source_id) : undefined;
            const activeIdx = activeId != null ? ids.findIndex((id) => id === activeId) : -1;
            const myIdx = ids.findIndex((id) => id === l.stream_id);
            const isOver = overId === l.stream_id && activeId !== overId;
            const dropIndicator =
              isOver && activeIdx !== -1 && myIdx !== -1
                ? activeIdx < myIdx
                  ? 'below'
                  : 'above'
                : null;

            return (
              <SortableTeamChannelRow
                key={l.stream_id}
                link={l}
                num={idx}
                isPrimary={isPrimary}
                sourceName={sourceName}
                dropIndicator={dropIndicator}
                onMakePrimary={() => onSetPrimary(team, l.stream_id)}
                onRemove={() => onUnlinkChannel(team, l.stream_id)}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// ─── Team Channel Settings Main Component ─────────────────────────────────────

export function TeamChannelSettings() {
  const { t } = useTranslation('sports');
  const links = useTeamChannelLinksStore((s) => s.links);
  const ensureLoaded = useTeamChannelLinksStore((s) => s.ensureLoaded);
  const linkTeam = useTeamChannelLinksStore((s) => s.linkTeam);
  const unlinkTeam = useTeamChannelLinksStore((s) => s.unlinkTeam);
  const unlinkTeamChannel = useTeamChannelLinksStore((s) => s.unlinkTeamChannel);
  const unlinkLeague = useTeamChannelLinksStore((s) => s.unlinkLeague);
  const setPrimaryChannel = useTeamChannelLinksStore((s) => s.setPrimaryChannel);
  const autoLinkLeague = useTeamChannelLinksStore((s) => s.autoLinkLeague);
  const reorderTeamLinks = useTeamChannelLinksStore((s) => s.reorderTeamLinks);

  const enabledLeagues = useSportsSettingsStore((s) => s.enabledLeagues);

  // Filter available leagues: only enabled team leagues!
  const enabledTeamLeagues = useMemo(() => {
    const valid = ALL_LEAGUES.filter(
      (l) => !INDIVIDUAL_SPORT_LEAGUES.has(l.id) && enabledLeagues.includes(l.id)
    ).sort((a, b) => a.name.localeCompare(b.name));

    // Fallback: If user has 0 enabled team leagues, show all team leagues with a notification
    if (valid.length === 0) {
      return ALL_LEAGUES.filter((l) => !INDIVIDUAL_SPORT_LEAGUES.has(l.id)).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
    }
    return valid;
  }, [enabledLeagues]);

  const [selectedLeagueId, setSelectedLeagueId] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [teams, setTeams] = useState<SportsTeam[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [autoLinking, setAutoLinking] = useState(false);
  const [suggestions, setSuggestions] = useState<TeamLinkSuggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);

  // Filters for suggestions
  const [minConfidence, setMinConfidence] = useState<number>(0.7);
  const [maxCandidatesPerTeam, setMaxCandidatesPerTeam] = useState<number>(1);
  const [acceptedCandidates, setAcceptedCandidates] = useState<Set<string>>(new Set());

  const [teamSearch, setTeamSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unlinked' | 'linked' | 'suggested'>('all');
  const [pickerTeam, setPickerTeam] = useState<SportsTeam | null>(null);
  const [sourcesMap, setSourcesMap] = useState<Map<string, string>>(new Map());
  const [categoriesMap, setCategoriesMap] = useState<Map<string, string>>(new Map());
  const [sourceOptions, setSourceOptions] = useState<SourceOption[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<CategoryOption[]>([]);
  const [autoLinkConfigOpen, setAutoLinkConfigOpen] = useState(false);
  const hasCustomConfig = useLeagueAutoLinkConfigStore((s) => s.hasCustomConfig);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'info' | 'error' } | null>(null);
  const [confirmUnlinkOpen, setConfirmUnlinkOpen] = useState(false);

  // Load store, sources, and categories
  useEffect(() => {
    ensureLoaded();
    async function loadSourcesAndCategories() {
      try {
        const sOpts: SourceOption[] = [];
        const map = new Map<string, string>();
        if (window.storage) {
          const res = await window.storage.getSources();
          if (res?.data) {
            for (const s of res.data) {
              if (s.enabled !== false) {
                sOpts.push({ id: s.id, name: s.name || s.id });
              }
              map.set(s.id, s.name || s.id);
            }
            setSourcesMap(map);
            setSourceOptions(sOpts);
          }
        }
        const cats = await db.categories.toArray();
        const catMap = new Map<string, string>();
        const catOpts: CategoryOption[] = [];
        const enabledSourceIdSet = new Set(sOpts.map((s) => s.id));

        for (const c of cats) {
          const isCatEnabled = c.enabled !== false;
          if (!isCatEnabled) continue;

          if (c.source_id && sOpts.length > 0 && !enabledSourceIdSet.has(c.source_id)) {
            continue;
          }

          const name = c.alias || c.category_name;
          if (c.source_id && c.category_id) {
            catMap.set(`${c.source_id}:${c.category_id}`, name);
          }
          if (c.category_id) {
            catMap.set(String(c.category_id), name);
          }
          catOpts.push({
            id: String(c.category_id),
            name,
            source_id: c.source_id,
            source_name: c.source_id ? map.get(c.source_id) : undefined,
            channel_count: c.channel_count,
          });
        }
        setCategoryOptions(catOpts);
        setCategoriesMap(catMap);
      } catch (e) {
        console.error('[TeamChannelSettings] Failed to load sources/categories:', e);
      }
    }
    loadSourcesAndCategories();
  }, [ensureLoaded]);

  // Set default selected league
  useEffect(() => {
    if (enabledTeamLeagues.length === 0) return;
    if (!selectedLeagueId || !enabledTeamLeagues.some((l) => l.id === selectedLeagueId)) {
      setSelectedLeagueId(enabledTeamLeagues[0].id);
    }
  }, [enabledTeamLeagues, selectedLeagueId]);

  // Sync filters with league config when league changes
  useEffect(() => {
    if (!selectedLeagueId) return;
    let cancelled = false;
    (async () => {
      await useLeagueAutoLinkConfigStore.getState().ensureLoaded();
      if (cancelled) return;
      const cfg = useLeagueAutoLinkConfigStore.getState().getConfig(selectedLeagueId);
      setMinConfidence(cfg.minConfidence ?? 0.7);
      setMaxCandidatesPerTeam(cfg.maxCandidatesPerTeam ?? 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedLeagueId]);

  // Load teams when selected league changes
  useEffect(() => {
    if (!selectedLeagueId) return;
    let cancelled = false;
    setTeamsLoading(true);
    setSuggestions([]);
    setAcceptedCandidates(new Set());
    getLeagueTeams(selectedLeagueId)
      .then((res) => {
        if (!cancelled) setTeams(res);
      })
      .catch((err) => {
        console.error('[TeamChannelSettings] Failed to load teams:', err);
        if (!cancelled) setTeams([]);
      })
      .finally(() => {
        if (!cancelled) setTeamsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedLeagueId]);

  const showToast = useCallback((text: string, type: 'success' | 'info' | 'error' = 'info') => {
    setToastMessage({ text, type });
    window.setTimeout(() => {
      setToastMessage((cur) => (cur?.text === text ? null : cur));
    }, 4000);
  }, []);

  const handleAutoLink = useCallback(
    async (customConfig?: LeagueAutoLinkConfig) => {
      if (!selectedLeagueId || autoLinking) return;
      if (customConfig?.minConfidence !== undefined) {
        setMinConfidence(customConfig.minConfidence);
      }
      if (customConfig?.maxCandidatesPerTeam !== undefined) {
        setMaxCandidatesPerTeam(customConfig.maxCandidatesPerTeam);
      }
      setAutoLinking(true);
      setSuggestions([]);
      setAcceptedCandidates(new Set());
      try {
        const result = await autoLinkLeague(selectedLeagueId, customConfig);
        setSuggestions(result.suggestions);
        setSuggestionsOpen(true);
        if (result.autoLinked > 0) {
          showToast(
            t('autoLinkedCount', { count: result.autoLinked, total: result.teamCount }),
            'success'
          );
        } else if (result.suggestions.length > 0) {
          showToast(
            t('foundMatchesForTeams', { count: result.suggestions.length }),
            'success'
          );
        } else {
          showToast(t('noChannelsFound'), 'info');
        }
      } catch (err) {
        console.error('[TeamChannelSettings] Auto-link failed:', err);
        showToast(t('autoLinkFailed'), 'error');
      } finally {
        setAutoLinking(false);
      }
    },
    [selectedLeagueId, autoLinking, autoLinkLeague, showToast, t]
  );

  // Filtered suggestions based on confidence and channels per team
  const filteredSuggestions = useMemo(() => {
    return suggestions
      .map((s) => {
        const validCandidates = s.candidates
          .filter((c) => c.score >= minConfidence)
          .slice(0, maxCandidatesPerTeam);

        return {
          ...s,
          candidates: validCandidates,
          best: validCandidates[0] || null,
        };
      })
      .filter((s) => s.candidates.length > 0);
  }, [suggestions, minConfidence, maxCandidatesPerTeam]);

  // Count of total channels that will be linked across filtered suggestions
  const totalFilteredChannelsCount = useMemo(() => {
    return filteredSuggestions.reduce((acc, s) => acc + s.candidates.length, 0);
  }, [filteredSuggestions]);

  // Individual Candidate Accept Handler with instant visual feedback
  const handleAcceptCandidate = useCallback(
    async (s: TeamLinkSuggestion, candidate: TeamChannelCandidate) => {
      const candidateKey = `${s.team.id}:${candidate.channel.stream_id}`;
      setAcceptedCandidates((prev) => new Set([...prev, candidateKey]));

      await linkTeam({
        league_id: s.leagueId,
        team_id: s.team.id,
        stream_id: candidate.channel.stream_id,
        channel_name: candidate.channel.alias || candidate.channel.name,
        source_id: candidate.channel.source_id,
        auto: 0,
        confidence: candidate.score,
      });

      showToast(
        t('linkedTeamToChannel', { team: s.team.name, channel: candidate.channel.alias || candidate.channel.name }),
        'success'
      );
    },
    [linkTeam, showToast, t]
  );

  // Batch Accept Handler for filtered suggestions
  const handleAcceptAllFiltered = useCallback(async () => {
    const newlyAccepted = new Set(acceptedCandidates);
    let linkedCount = 0;

    for (const s of filteredSuggestions) {
      for (let idx = 0; idx < s.candidates.length; idx++) {
        const candidate = s.candidates[idx];
        const key = `${s.team.id}:${candidate.channel.stream_id}`;
        if (newlyAccepted.has(key)) continue;
        newlyAccepted.add(key);
        await linkTeam({
          league_id: s.leagueId,
          team_id: s.team.id,
          stream_id: candidate.channel.stream_id,
          channel_name: candidate.channel.alias || candidate.channel.name,
          source_id: candidate.channel.source_id,
          auto: 0,
          confidence: candidate.score,
        });
        linkedCount++;
      }
    }

    setAcceptedCandidates(newlyAccepted);
    showToast(
      t('linkedChannelsAcrossTeams', { count: linkedCount, teams: filteredSuggestions.length }),
      'success'
    );
  }, [filteredSuggestions, acceptedCandidates, linkTeam, showToast, t]);

  const handleLink = useCallback(
    (team: SportsTeam, channel: StoredChannel, confidence = 1) => {
      linkTeam({
        league_id: selectedLeagueId,
        team_id: team.id,
        stream_id: channel.stream_id,
        channel_name: channel.alias || channel.name,
        source_id: channel.source_id,
        auto: 0,
        confidence,
      });
      // Remove from suggestions if present
      setSuggestions((prev) => prev.filter((s) => s.team.id !== team.id));
      showToast(t('linkedTeamToChannel', { team: team.name, channel: channel.alias || channel.name }), 'success');
    },
    [selectedLeagueId, linkTeam, showToast, t]
  );

  const handleUnlinkChannel = useCallback(
    (team: SportsTeam, streamId: string) => {
      unlinkTeamChannel(selectedLeagueId, team.id, streamId);
      showToast(t('removedChannelFromTeam', { team: team.name }), 'info');
    },
    [selectedLeagueId, unlinkTeamChannel, showToast, t]
  );

  const handleSetPrimary = useCallback(
    (team: SportsTeam, streamId: string) => {
      setPrimaryChannel(selectedLeagueId, team.id, streamId);
      showToast(t('setPrimaryForTeam', { team: team.name }), 'success');
    },
    [selectedLeagueId, setPrimaryChannel, showToast, t]
  );

  const handleUnlinkTeamAll = useCallback(
    (team: SportsTeam) => {
      unlinkTeam(selectedLeagueId, team.id);
      showToast(t('unlinkedAllFromTeam', { team: team.name }), 'info');
    },
    [selectedLeagueId, unlinkTeam, showToast, t]
  );

  const handleUnlinkAllInLeague = useCallback(async () => {
    await unlinkLeague(selectedLeagueId);
    setConfirmUnlinkOpen(false);
    showToast(t('unlinkedAllTeamsForLeague'), 'info');
  }, [selectedLeagueId, unlinkLeague, showToast, t]);

  // Categories for sports filter
  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of enabledTeamLeagues) {
      map.set(l.category, (map.get(l.category) || 0) + 1);
    }
    return Array.from(map.entries()).map(([cat, count]) => ({ cat, count }));
  }, [enabledTeamLeagues]);

  const filteredLeagues = useMemo(() => {
    if (selectedCategory === 'all') return enabledTeamLeagues;
    return enabledTeamLeagues.filter((l) => l.category === selectedCategory);
  }, [enabledTeamLeagues, selectedCategory]);

  // Calculate league progress stats
  const leagueStats = useMemo(() => {
    const total = teams.length;
    let linked = 0;
    let totalBackups = 0;
    for (const team of teams) {
      const teamLinks = getTeamLinks(links, selectedLeagueId, team.id);
      if (teamLinks.length > 0) {
        linked++;
        if (teamLinks.length > 1) {
          totalBackups += teamLinks.length - 1;
        }
      }
    }
    const unlinked = total - linked;
    const percent = total > 0 ? Math.round((linked / total) * 100) : 0;
    return { total, linked, unlinked, totalBackups, percent };
  }, [teams, links, selectedLeagueId]);

  // Map of suggestions by team ID for fast inline access
  const suggestionsMap = useMemo(() => {
    const map = new Map<string, TeamLinkSuggestion>();
    for (const s of suggestions) {
      map.set(s.team.id, s);
    }
    return map;
  }, [suggestions]);

  // Filtered teams list based on search and status tabs
  const filteredTeams = useMemo(() => {
    let list = teams;

    // Filter by status
    if (statusFilter === 'linked') {
      list = list.filter((t) => getTeamLinks(links, selectedLeagueId, t.id).length > 0);
    } else if (statusFilter === 'unlinked') {
      list = list.filter((t) => getTeamLinks(links, selectedLeagueId, t.id).length === 0);
    } else if (statusFilter === 'suggested') {
      list = list.filter((t) => suggestionsMap.has(t.id));
    }

    // Filter by search query
    if (teamSearch.trim()) {
      const q = teamSearch.toLowerCase().trim();
      list = list.filter((t) => {
        const teamLinks = getTeamLinks(links, selectedLeagueId, t.id);
        const matchesChannels = teamLinks.some((l) => l.channel_name.toLowerCase().includes(q));
        return (
          t.name.toLowerCase().includes(q) ||
          (t.shortName && t.shortName.toLowerCase().includes(q)) ||
          matchesChannels
        );
      });
    }

    return list;
  }, [teams, links, selectedLeagueId, statusFilter, teamSearch, suggestionsMap]);

  const selectedLeagueObj = enabledTeamLeagues.find((l) => l.id === selectedLeagueId);

  return (
    <div className="tcs-root">
      {/* Toast Notification */}
      {toastMessage && (
        <div className={`tcs-toast tcs-toast-${toastMessage.type}`}>
          <span>{toastMessage.text}</span>
        </div>
      )}

      {/* Header bar */}
      <div className="tcs-header-strip">
        <div className="tcs-header-left">
          <div className="tcs-league-selector-wrap">
            <label className="tcs-control-label">{t('selectLeague')}</label>
            <select
              className="tcs-league-select"
              value={selectedLeagueId}
              onChange={(e) => setSelectedLeagueId(e.target.value)}
              aria-label={t('selectLeague')}
            >
              {filteredLeagues.map((l) => {
                return (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Sport category quick pills if multiple exist */}
          {categories.length > 1 && (
            <div className="tcs-category-pills">
              <button
                className={`tcs-category-pill ${selectedCategory === 'all' ? 'active' : ''}`}
                onClick={() => setSelectedCategory('all')}
              >
                {t('all')}
              </button>
              {categories.map(({ cat }) => (
                <button
                  key={cat}
                  className={`tcs-category-pill ${selectedCategory === cat ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedCategory(cat);
                    const firstInCat = enabledTeamLeagues.find((l) => l.category === cat);
                    if (firstInCat) setSelectedLeagueId(firstInCat.id);
                  }}
                >
                  {cat.charAt(0).toUpperCase() + cat.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="tcs-header-actions">
          <div className="tcs-autolink-btn-group">
            <button
              className="tcs-btn-autolink"
              onClick={() => handleAutoLink()}
              disabled={autoLinking || teamsLoading || teams.length === 0}
              title={t('autoLinkTeams')}
            >
              {autoLinking ? (
                <>
                  <span className="tcs-spinner-small" />
                  <span>{t('autoLinking')}</span>
                </>
              ) : (
                <>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
                  </svg>
                  <span>{t('autoLinkTeams')}</span>
                </>
              )}
            </button>
            <button
              className={`tcs-btn-autolink-cfg ${hasCustomConfig(selectedLeagueId) ? 'custom-active' : ''}`}
              onClick={() => setAutoLinkConfigOpen(true)}
              title={t('autoLinkSettings')}
              aria-label={t('autoLinkSettings')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
              </svg>
              {hasCustomConfig(selectedLeagueId) && <span className="tcs-cfg-dot" />}
            </button>
          </div>

          {leagueStats.linked > 0 && (
            <button
              className="tcs-btn-reset-league"
              onClick={() => setConfirmUnlinkOpen(true)}
              title={t('unlinkAll')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Progress & Stat Banner */}
      <div className="tcs-stats-card">
        <div className="tcs-stats-row">
          <div className="tcs-stats-summary">
            <span className="tcs-stats-league-name">{selectedLeagueObj?.name || t('league')}</span>
            <span className="tcs-stats-progress-text">
              {t('teamsLinkedProgress', { linked: leagueStats.linked, total: leagueStats.total })}
            </span>
          </div>
          <div className="tcs-stats-badges">
            <span className="tcs-stat-chip linked">
              <span className="tcs-dot green" />
              {leagueStats.linked} {t('filterLinked')}
            </span>
            {leagueStats.totalBackups > 0 && (
              <span className="tcs-stat-chip backup">
                <span className="tcs-dot blue" />
                {t('backupsCount', { count: leagueStats.totalBackups })}
              </span>
            )}
            <span className="tcs-stat-chip unlinked">
              <span className="tcs-dot amber" />
              {leagueStats.unlinked} {t('filterUnlinked')}
            </span>
            <span className="tcs-stat-percentage">{leagueStats.percent}%</span>
          </div>
        </div>

        <div className="tcs-progress-bar-track">
          <div
            className="tcs-progress-bar-fill"
            style={{ width: `${leagueStats.percent}%` }}
          />
        </div>
      </div>

      {/* Suggestions Review Panel with Configurable Filters */}
      {suggestions.length > 0 && (
        <div className="tcs-suggestions-panel">
          <div className="tcs-suggestions-panel-header">
            <div className="tcs-suggestions-panel-title" onClick={() => setSuggestionsOpen(!suggestionsOpen)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              <span>{t('reviewSuggestions')} ({filteredSuggestions.length})</span>
            </div>

            {/* Filter controls */}
            <div className="tcs-suggestions-filter-strip">
              <div className="tcs-suggestions-filter-item">
                <label className="tcs-mini-label">{t('minConfidence')}:</label>
                <select
                  className="tcs-mini-select"
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
                >
                  <option value={0.5}>50%+</option>
                  <option value={0.6}>60%+</option>
                  <option value={0.7}>70%+</option>
                  <option value={0.8}>80%+</option>
                  <option value={0.9}>90%+</option>
                </select>
              </div>

              <div className="tcs-suggestions-filter-item">
                <label className="tcs-mini-label">{t('channelsPerTeam')}:</label>
                <select
                  className="tcs-mini-select"
                  value={maxCandidatesPerTeam}
                  onChange={(e) => setMaxCandidatesPerTeam(parseInt(e.target.value, 10))}
                >
                  <option value={1}>1 (Primary only)</option>
                  <option value={2}>2 (Primary + 1 Backup)</option>
                  <option value={3}>3 (Primary + 2 Backups)</option>
                  <option value={5}>5 (All Candidates)</option>
                </select>
              </div>
            </div>

            <div className="tcs-suggestions-panel-actions">
              {filteredSuggestions.length > 0 && (
                <button className="tcs-btn-accept-all" onClick={handleAcceptAllFiltered}>
                  {maxCandidatesPerTeam > 1
                    ? t('acceptAllWithBackups', { count: totalFilteredChannelsCount })
                    : `${t('acceptAll')} (${filteredSuggestions.length})`}
                </button>
              )}
              <button
                className="tcs-btn-dismiss-suggestions"
                onClick={() => setSuggestions([])}
                title={t('dismissSuggestions')}
              >
                ✕
              </button>
            </div>
          </div>

          {suggestionsOpen && (
            filteredSuggestions.length === 0 ? (
              <div className="tcs-suggestions-empty-filter">
                <span>{t('noSuggestionsMatchFilter')}</span>
              </div>
            ) : (
              <div className="tcs-suggestions-grid">
                {filteredSuggestions.map((s) => {
                  return (
                    <div key={s.team.id} className="tcs-suggestion-item-card">
                      <div className="tcs-suggestion-team-badge">
                        <TeamLogo team={s.team} />
                        <span className="tcs-suggestion-team-name">{s.team.name}</span>
                        <span className="tcs-suggestion-team-count-tag">
                          {s.candidates.length === 1 ? t('matchesCountOne') : t('matchesCount', { count: s.candidates.length })}
                        </span>
                      </div>

                      {/* Render candidates list for this team */}
                      <div className="tcs-suggestion-candidates-list">
                        {s.candidates.map((cand, cIdx) => {
                          const isPrimary = cIdx === 0;
                          const matchPercent = Math.round(cand.score * 100);
                          const sourceName = cand.channel.source_id ? sourcesMap.get(cand.channel.source_id) : undefined;
                          const categoryName = getChannelCategoryName(cand.channel, categoriesMap);
                          const candidateKey = `${s.team.id}:${cand.channel.stream_id}`;
                          const isAccepted = acceptedCandidates.has(candidateKey);

                          return (
                            <div key={cand.channel.stream_id} className={`tcs-suggestion-channel-match ${isPrimary ? 'primary' : 'backup'}`}>
                              <div className="tcs-match-info-block">
                                <div className="tcs-match-info-top">
                                  <span className={`tcs-priority-tag-mini ${isPrimary ? 'primary' : 'backup'}`}>
                                    {isPrimary ? t('primaryChannel') : t('backupChannel', { num: cIdx })}
                                  </span>
                                  <span className="tcs-match-name" title={cand.channel.alias || cand.channel.name}>
                                    {cand.channel.alias || cand.channel.name}
                                  </span>
                                  <span className={`tcs-match-score-pill ${matchPercent >= 85 ? 'high' : 'medium'}`}>
                                    {matchPercent}%
                                  </span>
                                </div>

                                {(sourceName || categoryName) && (
                                  <div className="tcs-suggestion-meta">
                                    {sourceName && <span className="tcs-source-badge">{sourceName}</span>}
                                    {categoryName && <span className="tcs-category-badge">{categoryName}</span>}
                                  </div>
                                )}
                              </div>

                              {isAccepted ? (
                                <button className="tcs-btn-quick-accept accepted" disabled>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="20 6 9 17 4 12" />
                                  </svg>
                                  <span>{t('accepted')}</span>
                                </button>
                              ) : (
                                <button
                                  className="tcs-btn-quick-accept"
                                  onClick={() => handleAcceptCandidate(s, cand)}
                                >
                                  {isPrimary ? t('accept') : t('acceptAsBackup')}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      )}

      {/* Filter & Search Controls */}
      <div className="tcs-filter-bar">
        <div className="tcs-status-tabs">
          <button
            className={`tcs-status-tab ${statusFilter === 'all' ? 'active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            {t('filterAll')} ({teams.length})
          </button>
          <button
            className={`tcs-status-tab ${statusFilter === 'unlinked' ? 'active' : ''}`}
            onClick={() => setStatusFilter('unlinked')}
          >
            <span className="tcs-dot amber" />
            {t('filterUnlinked')} ({leagueStats.unlinked})
          </button>
          <button
            className={`tcs-status-tab ${statusFilter === 'linked' ? 'active' : ''}`}
            onClick={() => setStatusFilter('linked')}
          >
            <span className="tcs-dot green" />
            {t('filterLinked')} ({leagueStats.linked})
          </button>
          {suggestions.length > 0 && (
            <button
              className={`tcs-status-tab ${statusFilter === 'suggested' ? 'active' : ''}`}
              onClick={() => setStatusFilter('suggested')}
            >
              <span className="tcs-dot cyan" />
              {t('filterSuggestions')} ({suggestions.length})
            </button>
          )}
        </div>

        <div className="tcs-team-search-wrap">
          <svg className="tcs-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            className="tcs-team-search-input"
            type="text"
            placeholder={t('searchTeams')}
            value={teamSearch}
            onChange={(e) => setTeamSearch(e.target.value)}
          />
          {teamSearch && (
            <button className="tcs-team-search-clear" onClick={() => setTeamSearch('')}>
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Teams Grid / List */}
      <div className="tcs-teams-container">
        {teamsLoading ? (
          <div className="tcs-empty-state">
            <span className="tcs-spinner-large" />
            <p>{t('loadingTeamsFor', { league: selectedLeagueObj?.name || t('league') })}</p>
          </div>
        ) : teams.length === 0 ? (
          <div className="tcs-empty-state">
            <p>{t('noTeamsFound')}</p>
          </div>
        ) : filteredTeams.length === 0 ? (
          <div className="tcs-empty-state">
            <p>{t('noTeamsMatchFilter')}</p>
          </div>
        ) : (
          <div className="tcs-teams-grid">
            {filteredTeams.map((team) => {
              const teamLinks = getTeamLinks(links, selectedLeagueId, team.id);
              const hasLinks = teamLinks.length > 0;
              const suggestion = suggestionsMap.get(team.id);
              const { city, nickname } = splitTeamName(team.name);

              return (
                <div
                  key={team.id}
                  className={`tcs-team-card ${hasLinks ? 'is-linked' : 'is-unlinked'}`}
                >
                  <div className="tcs-team-card-top-row">
                    <div className="tcs-team-card-identity">
                      <TeamLogo team={team} />
                      <div className="tcs-team-name-box">
                        {city && <span className="tcs-team-city">{city}</span>}
                        <span className="tcs-team-nickname">{nickname}</span>
                      </div>
                    </div>

                    <div className="tcs-team-card-actions">
                      {hasLinks ? (
                        <>
                          <button
                            className="tcs-btn-add-backup"
                            onClick={() => setPickerTeam(team)}
                            title={t('addBackupChannel')}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                              <line x1="12" y1="5" x2="12" y2="19" />
                              <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                            <span>{t('addBackupChannel')}</span>
                          </button>
                          <button
                            className="tcs-btn-unlink-icon"
                            onClick={() => handleUnlinkTeamAll(team)}
                            title={t('unlinkAll')}
                            aria-label={t('unlinkAll')}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                              <path d="M18 6 6 18M6 6l12 12" />
                            </svg>
                          </button>
                        </>
                      ) : (
                        <button
                          className="tcs-btn-link-primary"
                          onClick={() => setPickerTeam(team)}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                          </svg>
                          <span>{t('linkChannel')}</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Multi-Channel List Area */}
                  <div className="tcs-team-channels-block">
                    {hasLinks ? (
                      <TeamChannelLinksSortable
                        links={teamLinks}
                        leagueId={selectedLeagueId}
                        team={team}
                        sourcesMap={sourcesMap}
                        onSetPrimary={handleSetPrimary}
                        onUnlinkChannel={handleUnlinkChannel}
                        onReorder={reorderTeamLinks}
                      />
                    ) : suggestion?.best ? (
                      <button
                        className="tcs-quick-link-btn"
                        onClick={() => handleLink(team, suggestion.best!.channel, suggestion.best!.score)}
                        title={t('quickLinkTo', { channel: suggestion.best.channel.alias || suggestion.best.channel.name })}
                      >
                        <span className="tcs-quick-link-tag">
                          ⚡ {t('quickLink')}: {suggestion.best.channel.alias || suggestion.best.channel.name}
                        </span>
                        <span className="tcs-match-percent">
                          {Math.round(suggestion.best.score * 100)}%
                        </span>
                      </button>
                    ) : (
                      <span className="tcs-unlinked-tag">{t('unlinkedStatus')}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Focused Channel Selection Modal */}
      <ChannelPickerDialog
        isOpen={!!pickerTeam}
        team={pickerTeam}
        leagueId={selectedLeagueId}
        existingTeamLinks={pickerTeam ? getTeamLinks(links, selectedLeagueId, pickerTeam.id) : []}
        sourcesMap={sourcesMap}
        categoriesMap={categoriesMap}
        onSelectChannel={(team, ch, score) => handleLink(team, ch, score)}
        onUnlinkChannel={(team, streamId) => handleUnlinkChannel(team, streamId)}
        onSetPrimary={(team, streamId) => handleSetPrimary(team, streamId)}
        onUnlinkAll={(team) => handleUnlinkTeamAll(team)}
        onClose={() => setPickerTeam(null)}
      />

      {/* Auto-Link Settings Modal */}
      {selectedLeagueObj && (
        <AutoLinkSettingsModal
          league={selectedLeagueObj}
          isOpen={autoLinkConfigOpen}
          onClose={() => setAutoLinkConfigOpen(false)}
          onSaveAndRun={(cfg) => handleAutoLink(cfg)}
          sources={sourceOptions}
          categories={categoryOptions}
        />
      )}

      {/* Confirm Unlink All in League Dialog */}
      {confirmUnlinkOpen && (
        <div className="tcs-confirm-overlay" onClick={() => setConfirmUnlinkOpen(false)}>
          <div className="tcs-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h4 className="tcs-confirm-title">{t('unlinkAll')}</h4>
            <p className="tcs-confirm-text">
              {t('confirmUnlinkAll', { league: selectedLeagueObj?.name || 'this league' })}
            </p>
            <div className="tcs-confirm-actions">
              <button
                className="tcs-btn-secondary"
                onClick={() => setConfirmUnlinkOpen(false)}
              >
                {i18n.t('common:cancel')}
              </button>
              <button
                className="tcs-btn-danger"
                onClick={handleUnlinkAllInLeague}
              >
                {t('unlinkAll')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Modal Shell Component ───────────────────────────────────────────────────

export function TeamChannelSettingsModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('sports');

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="tcs-modal-overlay" onClick={onClose}>
      <div
        className="tcs-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="tcs-modal-header">
          <div className="tcs-modal-title-wrap">
            <div className="tcs-modal-icon-badge">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="20" height="15" x="2" y="7" rx="2" ry="2" />
                <polyline points="17 2 12 7 7 2" />
              </svg>
            </div>
            <div>
              <h2 className="tcs-modal-title">{t('teamChannels')}</h2>
              <p className="tcs-modal-subtitle">{t('teamChannelsDesc')}</p>
            </div>
          </div>
          <button
            className="tcs-modal-close"
            onClick={onClose}
            aria-label={i18n.t('common:close')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="tcs-modal-body">
          <TeamChannelSettings />
        </div>
      </div>
    </div>,
    document.body
  );
}

export default TeamChannelSettings;
