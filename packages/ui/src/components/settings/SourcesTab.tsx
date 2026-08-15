import { useState, useRef, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Source, Channel } from '@ynotv/core';
import { syncAllSources, syncAllVod, syncSource, syncVodForSource, markSourceDeleted, syncGlobalEpgLinkStandalone, applyGlobalEpgToSource, cleanupGlobalEpgCache, type SyncResult, type VodSyncResult } from '../../db/sync';
import { clearSourceData, clearVodData, db, type StoredChannel, type StoredProgram } from '../../db';
import { dbEvents } from '../../db/sqlite-adapter';
import { useSyncStatus } from '../../hooks/useChannels';
import {
  useChannelSyncing,
  useSetChannelSyncing,
  useVodSyncing,
  useSetVodSyncing,
  useSyncStatusMessage,
  useSetSyncStatusMessage,
  useEpgClockFormat
} from '../../stores/uiStore';
import { useToastStore } from '../../stores/toastStore';
import { parseM3U, XtreamClient, StalkerClient } from '@ynotv/local-adapter';
import { CategoryManager } from './CategoryManager';
import { DataRefreshTab } from './DataRefreshTab';
import './SourcesTab.css';
import { useAppSettings } from '../../hooks/useAppSettings';
import { useSourceVersion } from '../../contexts/SourceVersionContext';
import type { GlobalEpgLink } from '../../types/app';
import { decompressEpgDescription } from '../../utils/compression';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import { formatTime, formatDate, activeLocale } from '../../utils/dateTime';
import i18n, { translateNativeError } from '../../i18n';

export type SourcesSubTabId = 'source' | 'epg' | 'refresh' | 'global_ua';

const PRESET_USER_AGENTS = [
  { labelKey: 'settings:sources.uaVlcDefault', value: 'VLC/3.0.18 LibVLC/3.0.18' },
  { labelKey: 'settings:sources.uaTivimate', value: 'TiviMate/4.6.0' },
  { labelKey: 'settings:sources.uaGse', value: 'GSE Smart IPTV' },
  { labelKey: 'settings:sources.uaIptvSmarters', value: 'IPTVSmarters' },
];

interface SourcesTabProps {
  initialSubTab?: SourcesSubTabId;
  sources: Source[];
  isEncryptionAvailable: boolean;
  onSourcesChange: () => void;
  editSourceId?: string | null;
  epgSyncConcurrency?: number;
  // Data Refresh sub-tab props
  vodRefreshHours?: number;
  epgRefreshHours?: number;
  onVodRefreshChange?: (hours: number) => void;
  onEpgRefreshChange?: (hours: number) => void;
  onEpgSyncConcurrencyChange?: (value: number) => void;
}

type SourceType = 'm3u' | 'xtream' | 'stalker';

interface SourceFormData {
  name: string;
  type: SourceType;
  url: string;
  username: string;
  password: string;
  mac: string;
  autoLoadEpg: boolean;
  liveTvOnly: boolean;
  vodOnly: boolean;
  epgUrl: string;
  additionalEpgUrls: string[];
  userAgent: string;
  epgTimeshiftHours: number;
  customRefreshInterval: number;
  customVodRefreshInterval: number;
  backupMacs: string[];
  backupCredentials: Array<{ username: string; password: string }>;
  backupUrls: string[];
  pendingSwap: boolean;
  display_order?: number;
  advancedEpgMatching: boolean;
  disableShortEpg: boolean;
  xtreamCatchupUrl: string;
  xtreamCatchupUsername: string;
  xtreamCatchupPassword: string;
}

const emptyForm: SourceFormData = {
  name: '',
  type: 'm3u',
  url: '',
  username: '',
  password: '',
  mac: '',
  autoLoadEpg: true,
  liveTvOnly: false,
  vodOnly: false,
  epgUrl: '',
  additionalEpgUrls: [],
  userAgent: '',
  epgTimeshiftHours: 0,
  customRefreshInterval: 0,
  customVodRefreshInterval: 0,
  backupMacs: [],
  backupCredentials: [],
  backupUrls: [],
  pendingSwap: false,
  display_order: undefined,
  advancedEpgMatching: false,
  disableShortEpg: false,
  xtreamCatchupUrl: '',
  xtreamCatchupUsername: '',
  xtreamCatchupPassword: '',
};

// Normalize vendor Expiration Strings to concise MM/DD/YY
function formatExpiryDate(dateString?: string): string {
  if (!dateString) return '';
  // Clean " at " logic for Xtream vendor strings
  const cleanString = dateString.replace(' at ', ' ');
  let parsedDate = new Date(cleanString);

  // Fallback to numeric Unix Epoch string check
  if (isNaN(parsedDate.getTime()) && !isNaN(Number(dateString))) {
    parsedDate = new Date(Number(dateString) * 1000);
  }

  if (isNaN(parsedDate.getTime())) {
    return dateString; // Return arbitrary vendor text if it totally fails
  }

  const mm = String(parsedDate.getMonth() + 1).padStart(2, '0');
  const dd = String(parsedDate.getDate()).padStart(2, '0');
  const yy = String(parsedDate.getFullYear()).slice(-2);

  return `${mm}/${dd}/${yy}`;
}

// Returns true if the expiry date is expired or within 30 days
function isExpiryWarning(dateString?: string): boolean {
  if (!dateString) return false;
  const cleanString = dateString.replace(' at ', ' ');
  let d = new Date(cleanString);
  if (isNaN(d.getTime()) && !isNaN(Number(dateString))) {
    d = new Date(Number(dateString) * 1000);
  }
  if (isNaN(d.getTime())) return false;
  const daysLeft = (d.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return daysLeft <= 30;
}

// Format time difference in human-readable format
function formatTimeAgo(date: Date | null | undefined): string {
  if (!date) return i18n.t('time:neverSynced');

  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return i18n.t('time:justNow');
  if (diffMinutes < 60) return i18n.t('time:minuteAgo', { count: diffMinutes });
  if (diffHours < 24) return i18n.t('time:hourAgo', { count: diffHours });
  if (diffDays < 7) return i18n.t('time:dayAgo', { count: diffDays });
  const weeks = Math.floor(diffDays / 7);
  return i18n.t('time:weekAgo', { count: weeks });
}

const SettingsIcon = ({ size = 16 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const TrashIcon = ({ size = 16 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

const SpinnerIcon = ({ size = 16 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', animation: 'epg-spin 1s linear infinite' }}>
    <line x1="12" y1="2" x2="12" y2="6" />
    <line x1="12" y1="18" x2="12" y2="22" />
    <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
    <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
    <line x1="2" y1="12" x2="6" y2="12" />
    <line x1="18" y1="12" x2="22" y2="12" />
    <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
    <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
  </svg>
);

const TvIcon = ({ size = 12 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}>
    <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
    <polyline points="17 2 12 7 7 2" />
  </svg>
);

const FilmIcon = ({ size = 12 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}>
    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
    <line x1="7" y1="2" x2="7" y2="22" />
    <line x1="17" y1="2" x2="17" y2="22" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <line x1="2" y1="7" x2="7" y2="7" />
    <line x1="2" y1="17" x2="7" y2="17" />
    <line x1="17" y1="17" x2="22" y2="17" />
    <line x1="17" y1="7" x2="22" y2="7" />
  </svg>
);

const LinkIcon = ({ size = 12 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

const ClockIcon = ({ size = 12 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

interface SortableSourceItemProps {
  source: Source;
  meta: any;
  syncingSourceId: string | null;
  vodSyncingSourceId: string | null;
  syncStatusMsg: string | null;
  isDeleting: boolean;
  isExpiryWarning: (dateStr?: string) => boolean;
  formatExpiryDate: (dateStr: string) => string;
  formatTimeAgo: (date: Date | null) => string;
  handleToggleEnabled: (id: string) => void;
  handleSourceSync: (id: string) => void;
  handleSourceVodSync: (id: string) => void;
  setCategoryManagerSource: (src: { id: string; name: string }) => void;
  handleEdit: (source: Source) => void;
  handleDeleteClick: (id: string, name: string) => void;
}

function SortableSourceItem(props: SortableSourceItemProps) {
  const {
    source,
    meta,
    syncingSourceId,
    vodSyncingSourceId,
    syncStatusMsg,
    isDeleting,
    isExpiryWarning,
    formatExpiryDate,
    formatTimeAgo,
    handleToggleEnabled,
    handleSourceSync,
    handleSourceVodSync,
    setCategoryManagerSource,
    handleEdit,
    handleDeleteClick,
  } = props;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: source.id });

  useTranslation();

  // NOTE: opacity is only set while dragging. When idle, leave it unset so the
  // CSS class (.source-item.source-disabled -> opacity 0.5) controls the look;
  // an inline opacity: 1 here would override the disabled greying-out.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
    zIndex: isDragging ? 99 : 1,
    touchAction: 'none',
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`source-item${isDragging ? ' dragging' : ''}${source.enabled !== false ? ' source-enabled' : ' source-disabled'}`}
    >
      <div className="source-info">
        <div className="source-header">
          <div className="source-name-type">
            <span className="source-name">{source.name}</span>
            <span className="source-type" data-source-type={source.type}>{source.type.toUpperCase()}</span>
            <label className="source-toggle" onPointerDown={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={source.enabled !== false}
                onChange={() => handleToggleEnabled(source.id)}
                title={source.enabled !== false ? i18n.t('common:enabled') : i18n.t('common:disabled')}
              />
              <span className="toggle-label">
                {source.enabled !== false ? i18n.t('common:enabled') : i18n.t('common:disabled')}
              </span>
            </label>
          </div>
          <span className="last-sync-time">
            {formatTimeAgo(meta?.last_synced ? new Date(meta.last_synced) : null)}
          </span>
        </div>

        <div className="source-details">
          {meta && (
            <>
              {meta.channel_count > 0 && (
                <span className="stat-chip stat-chip--count">
                  <TvIcon size={11} />
                  <span>{i18n.t('settings:sources.channelsCount', { count: meta.channel_count.toLocaleString(activeLocale()) })}</span>
                </span>
              )}
              {((meta.vod_movie_count ?? 0) + (meta.vod_series_count ?? 0)) > 0 && (
                <span className="stat-chip stat-chip--count">
                  <FilmIcon size={11} />
                  <span>{i18n.t('settings:sources.moviesCount', { count: (meta.vod_movie_count ?? 0).toLocaleString(activeLocale()) })}</span>
                  {(meta.vod_series_count ?? 0) > 0 && (
                    <span className="stat-chip-divider" />
                  )}
                  {(meta.vod_series_count ?? 0) > 0 && (
                    <span>{i18n.t('settings:sources.seriesCount', { count: (meta.vod_series_count ?? 0).toLocaleString(activeLocale()) })}</span>
                  )}
                </span>
              )}
            </>
          )}

          {(source.type === 'xtream' || (source as any).xtream_catchup) && meta && meta.active_cons && meta.max_connections && (
            <span className="stat-chip stat-chip--count">
              <LinkIcon size={11} />
              <span>{i18n.t('settings:sources.connectionsCount', { active: meta.active_cons, max: meta.max_connections })}</span>
            </span>
          )}

          {meta && meta.expiry_date && (
            <span className={`stat-chip stat-chip--expiry${isExpiryWarning(meta.expiry_date) ? ' stat-chip--expiry-warn' : ''}`}>
              <ClockIcon size={11} />
              <span>{i18n.t('settings:sources.expLabel')} {formatExpiryDate(meta.expiry_date)}</span>
            </span>
          )}
        </div>
      </div>

      <div className="source-actions" onPointerDown={(e) => e.stopPropagation()}>
        <button
          className="src-btn src-btn--primary"
          onClick={() => handleSourceSync(source.id)}
          disabled={syncingSourceId === source.id || !source.enabled}
          title={i18n.t('settings:sources.syncThisSource')}
        >
          {syncingSourceId === source.id ? <><SpinnerIcon size={13} /> {syncStatusMsg || i18n.t('common:syncing')}</> : i18n.t('settings:sources.syncChannelsBtn')}
        </button>

        {(source.type === 'xtream' || source.type === 'stalker') && !source.live_tv_only && (
          <button
            className="src-btn src-btn--secondary"
            onClick={() => handleSourceVodSync(source.id)}
            disabled={vodSyncingSourceId === source.id || !source.enabled}
            title={i18n.t('settings:sources.syncThisVod')}
          >
            {vodSyncingSourceId === source.id ? <><SpinnerIcon size={13} /> {i18n.t('common:syncing')}</> : i18n.t('settings:sources.syncVodBtn')}
          </button>
        )}

        <button
          className="src-btn src-btn--secondary"
          onClick={() => setCategoryManagerSource({ id: source.id, name: source.name })}
          title={i18n.t('settings:sources.manageCategories')}
        >
          {i18n.t('settings:sources.categories')}
        </button>

        <button
          className="action-icon-btn"
          onClick={() => handleEdit(source)}
          title={i18n.t('settings:sources.editSource')}
        >
          <SettingsIcon size={16} />
        </button>

        <button
          className="action-icon-btn delete"
          onClick={() => handleDeleteClick(source.id, source.name)}
          disabled={isDeleting}
          title={i18n.t('settings:sources.deleteSource')}
        >
          {isDeleting ? <SpinnerIcon size={16} /> : <TrashIcon size={16} />}
        </button>
      </div>
    </li>
  );
}

interface SortableEpgCardProps {
  epg: GlobalEpgLink;
  index: number;
  isLast: boolean;
  sources: Source[];
  isSyncing: boolean;
  syncingAllEpg: boolean;
  formatLastSynced: (timestamp?: number) => string;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onSync: (epg: GlobalEpgLink) => void;
  onViewMatches: (epg: GlobalEpgLink) => void;
  onEdit: (epg: GlobalEpgLink) => void;
  onDelete: (epg: GlobalEpgLink) => void;
}

/**
 * Sortable global EPG link card — the whole card surface is the drag handle.
 * Interactive controls stop pointer propagation so clicks never start a drag
 * (the PointerSensor's 5px activation distance is a second guard).
 */
function SortableEpgCard(props: SortableEpgCardProps) {
  const {
    epg,
    index,
    isLast,
    sources,
    isSyncing,
    syncingAllEpg,
    formatLastSynced,
    onMoveUp,
    onMoveDown,
    onSync,
    onViewMatches,
    onEdit,
    onDelete,
  } = props;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: epg.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 99 : 1,
    touchAction: 'none',
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`epg-card${isSyncing ? ' syncing' : ''}${isDragging ? ' dragging' : ''}`}
    >
      {/* Priority badge */}
      <div className="epg-priority">{index + 1}</div>

      <div className="epg-card-content">
        {/* Header row: name + status */}
        <div className="epg-card-header">
          <span className="epg-card-name">{epg.name}</span>
          <span className={`epg-status${epg.lastSynced ? ' synced' : ' never'}`}>
            {formatLastSynced(epg.lastSynced)}
          </span>
        </div>

        {/* Linked sources as pills */}
        <div className="epg-card-sources">
          {epg.sourceIds.map(id => {
            const src = sources.find(s => s.id === id);
            return (
              <span key={id} className="epg-source-pill">
                {src?.name || id}
              </span>
            );
          })}
        </div>

        {/* Sync results bar */}
        {epg.lastSyncResult && (
          <div className="epg-card-results">
            <span className="epg-results-total">
              {epg.lastSyncResult.channelsMatched !== undefined 
                ? i18n.t('settings:sources.channelsPrograms', { channels: epg.lastSyncResult.channelsMatched.toLocaleString(activeLocale()), programs: epg.lastSyncResult.totalInserted.toLocaleString(activeLocale()) }) 
                : i18n.t('settings:sources.programsCount', { count: epg.lastSyncResult.totalInserted.toLocaleString(activeLocale()) })}
            </span>
            <div className="epg-results-breakdown">
              {Object.entries(epg.lastSyncResult.perSource).map(([srcId, count]) => {
                const srcName = sources.find(s => s.id === srcId)?.name || srcId;
                const channelCount = epg.lastSyncResult?.perSourceChannels?.[srcId];
                return (
                  <span key={srcId} className="epg-results-item">
                    {srcName}: {channelCount !== undefined ? i18n.t('settings:sources.channelsCount', { count: channelCount.toLocaleString(activeLocale()) }) + ', ' : ''}{i18n.t('settings:sources.programsCount', { count: Number(count).toLocaleString(activeLocale()) })}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Actions row */}
      <div className="epg-card-actions">
        <button
          className="epg-reorder-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onMoveUp(index)}
          disabled={index === 0}
          title={i18n.t('settings:sources.higherPriority')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <button
          className="epg-reorder-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onMoveDown(index)}
          disabled={isLast}
          title={i18n.t('settings:sources.lowerPriority')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div className="epg-action-divider" />
        <button
          className="epg-sync-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onSync(epg)}
          disabled={isSyncing || syncingAllEpg}
          title={i18n.t('settings:sources.syncThisEpg')}
        >
          {isSyncing ? (
            <svg className="epg-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/></svg>
          )}
          {isSyncing ? i18n.t('common:syncing') : i18n.t('common:sync')}
        </button>
        <button
          className="epg-icon-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onViewMatches(epg)}
          title={i18n.t('settings:sources.viewMatches')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"></line>
            <line x1="8" y1="12" x2="21" y2="12"></line>
            <line x1="8" y1="18" x2="21" y2="18"></line>
            <line x1="3" y1="6" x2="3.01" y2="6"></line>
            <line x1="3" y1="12" x2="3.01" y2="12"></line>
            <line x1="3" y1="18" x2="3.01" y2="18"></line>
          </svg>
        </button>
        <button
          className="epg-icon-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onEdit(epg)}
          title={i18n.t('common:edit')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button
          className="epg-icon-btn delete"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onDelete(epg)}
          title={i18n.t('common:delete')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </li>
  );
}

export function SourcesTab({
  initialSubTab,
  sources,
  isEncryptionAvailable,
  onSourcesChange,
  editSourceId,
  epgSyncConcurrency = 0,
  vodRefreshHours = 24,
  epgRefreshHours = 6,
  onVodRefreshChange,
  onEpgRefreshChange,
  onEpgSyncConcurrencyChange,
}: SourcesTabProps) {
  const { incrementVersion } = useSourceVersion(); // Get version incrementer
  useTranslation();
  const { globalLiveTvUserAgent, setGlobalLiveTvUserAgent, hideDisabledSources, setHideDisabledSources } = useAppSettings();
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<SourceFormData>(emptyForm);
  const [discoveredEpgUrl, setDiscoveredEpgUrl] = useState<string>('');

  useEffect(() => {
    if (!editingId) {
      setDiscoveredEpgUrl('');
      return;
    }
    db.sourcesMeta.get(editingId).then(meta => {
      setDiscoveredEpgUrl(meta?.epg_url || '');
    }).catch(() => {
      setDiscoveredEpgUrl('');
    });
  }, [editingId]);

  const xtreamBuiltEpgUrl = useMemo(() => {
    if (formData.type !== 'xtream') return '';
    const url = (formData.url || '').trim();
    const user = (formData.username || '').trim();
    const pass = (formData.password || '').trim();
    if (!url || !user || !pass) return '';
    if (url.includes('xmltv.php')) return url;
    const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
    return `${baseUrl}/xmltv.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
  }, [formData.type, formData.url, formData.username, formData.password]);

  const displayedBuiltEpgUrl = discoveredEpgUrl || xtreamBuiltEpgUrl;
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncResults, setSyncResults] = useState<Map<string, SyncResult> | null>(null);
  const [vodSyncResults, setVodSyncResults] = useState<Map<string, VodSyncResult> | null>(null);
  const syncStatus = useSyncStatus();

  // Global sync state - persists across Settings open/close
  const syncing = useChannelSyncing();
  const setSyncing = useSetChannelSyncing();
  const vodSyncing = useVodSyncing();
  const setVodSyncing = useSetVodSyncing();
  const syncStatusMsg = useSyncStatusMessage();
  const setSyncStatusMsg = useSetSyncStatusMessage();

  // Per-source sync state
  const [syncingSourceId, setSyncingSourceId] = useState<string | null>(null);
  const [vodSyncingSourceId, setVodSyncingSourceId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // State for inline backup inputs
  const [newBackupMac, setNewBackupMac] = useState('');
  const [showBackupMacInput, setShowBackupMacInput] = useState(false);
  const [newBackupUser, setNewBackupUser] = useState('');
  const [newBackupPass, setNewBackupPass] = useState('');
  const [showBackupCredInput, setShowBackupCredInput] = useState(false);

  // State for additional EPG URLs
  const [newAdditionalEpgUrl, setNewAdditionalEpgUrl] = useState('');
  const [showAdditionalEpgInput, setShowAdditionalEpgInput] = useState(false);

  // State for backup URLs
  const [newBackupUrl, setNewBackupUrl] = useState('');
  const [showBackupUrlInput, setShowBackupUrlInput] = useState(false);
  const [backupTestStatus, setBackupTestStatus] = useState<Map<number, 'idle' | 'testing' | 'success' | 'error'>>(new Map());

  // Password visibility state
  const [showPassword, setShowPassword] = useState(false);
  const [showBackupPassword, setShowBackupPassword] = useState(false);

  // Category manager modal state
  const [categoryManagerSource, setCategoryManagerSource] = useState<{ id: string; name: string } | null>(null);

  // Delete confirmation modal state
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);

  // Backup delete confirmation modal state
  const [deleteBackupConfirm, setDeleteBackupConfirm] = useState<{ type: 'stalker' | 'xtream'; index: number } | null>(null);

  // Sub-tab state: 'source' | 'epg' | 'refresh' | 'global_ua'
  const [activeSubTab, setActiveSubTab] = useState<SourcesSubTabId>('source');

  useEffect(() => {
    if (initialSubTab) {
      setActiveSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  // Global EPG links state
  const [globalEpgLinks, setGlobalEpgLinks] = useState<GlobalEpgLink[]>([]);
  const [showAddEpgForm, setShowAddEpgForm] = useState(false);
  const [editingEpgId, setEditingEpgId] = useState<string | null>(null);
  const [epgFormData, setEpgFormData] = useState({ name: '', url: '', sourceIds: [] as string[], saveEntireEpg: false });
  const [epgFormError, setEpgFormError] = useState<string | null>(null);
  const [deleteEpgConfirm, setDeleteEpgConfirm] = useState<GlobalEpgLink | null>(null);
  const [viewMatchesEpg, setViewMatchesEpg] = useState<GlobalEpgLink | null>(null);
  const [syncingEpgId, setSyncingEpgId] = useState<string | null>(null);
  const [syncingAllEpg, setSyncingAllEpg] = useState(false);

  // Load global EPG links from settings
  async function loadGlobalEpgLinks() {
    if (!window.storage) return;
    const result = await window.storage.getSettings();
    if (result.data?.globalEpgLinks) {
      setGlobalEpgLinks(result.data.globalEpgLinks);
    }
  }

  useEffect(() => {
    loadGlobalEpgLinks();
  }, []);

  const hasVodSource = sources.some(s => s.type === 'xtream' || s.type === 'stalker');

  // Sorted global EPG links for rendering (lower display_order = higher priority)
  const sortedEpgLinks = useMemo(() => {
    return [...globalEpgLinks].sort((a, b) => {
      const orderA = a.display_order ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.display_order ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });
  }, [globalEpgLinks]);

  // Handle auto-opening edit form when requested
  useEffect(() => {
    if (editSourceId && sources.length > 0) {
      const sourceToEdit = sources.find(s => s.id === editSourceId);
      if (sourceToEdit && editingId !== editSourceId) {
        handleEdit(sourceToEdit);
      }
    }
  }, [editSourceId, sources]);

  // Drag and drop state
  const dragFromIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Sorted sources for rendering (ensures UI matches DB order)
  const sortedSources = useMemo(() => {
    return [...sources].sort((a, b) => {
      const orderA = a.display_order ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.display_order ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });
  }, [sources]);

  // Hide/Show disabled sources in the Playlist Sources list (persisted)
  const visibleSources = useMemo(() => {
    return hideDisabledSources
      ? sortedSources.filter((s) => s.enabled !== false)
      : sortedSources;
  }, [sortedSources, hideDisabledSources]);

  // Track imported M3U data (file import flow)
  const [importedM3U, setImportedM3U] = useState<{
    channels: number;
    categories: number;
    epgUrl?: string;
    rawContent: string;
  } | null>(null);

  function handleAdd() {
    setFormData(emptyForm);
    setEditingId(null);
    setImportedM3U(null);
    setShowAddForm(true);
    setError(null);
  }

  async function handleImportM3U() {
    if (!window.storage) return;

    const result = await window.storage.importM3UFile();
    if (result.canceled || !result.data) return;

    const { content, fileName } = result.data;

    // Parse to validate and extract info
    const tempSourceId = 'temp-import';
    const parsed = parseM3U(content, tempSourceId);

    setImportedM3U({
      channels: parsed.channels.length,
      categories: parsed.categories.length,
      epgUrl: parsed.epgUrl ?? undefined,
      rawContent: content,
    });

    setFormData({
      ...emptyForm,
      name: fileName,
      type: 'm3u',
      url: '', // No URL for file imports
      autoLoadEpg: !!parsed.epgUrl,
      epgUrl: parsed.epgUrl ?? '',
      userAgent: '',
      epgTimeshiftHours: 0,
    });

    setEditingId(null);
    setShowAddForm(true);
    setError(null);
  }

  function handleEdit(source: Source) {
    const xtreamCatchup = (source as any).xtream_catchup;
    console.log('[SourcesTab] handleEdit - source.epg_url:', source.epg_url, 'length:', source.epg_url?.length);
    setFormData({
      name: source.name,
      type: source.type as SourceType, // Use the actual type directly
      url: source.url,
      username: source.username || '',
      password: source.password || '',
      mac: source.mac || '',
      autoLoadEpg: source.auto_load_epg ?? (source.type === 'xtream'),
      liveTvOnly: source.live_tv_only ?? false,
      vodOnly: source.vod_only ?? false,
      epgUrl: source.epg_url || '',
      additionalEpgUrls: source.additional_epg_urls || [],
      userAgent: source.user_agent || '',
      epgTimeshiftHours: source.epg_timeshift_hours || 0,
      customRefreshInterval: source.custom_refresh_interval || 0,
      customVodRefreshInterval: source.custom_vod_refresh_interval || 0,
      backupMacs: source.backup_macs || [],
      backupCredentials: source.backup_credentials || [],
      backupUrls: source.backup_urls || [],
      pendingSwap: false,
      display_order: source.display_order,
      advancedEpgMatching: source.advanced_epg_matching ?? false,
      disableShortEpg: source.disable_short_epg ?? false,
      xtreamCatchupUrl: xtreamCatchup?.url || '',
      xtreamCatchupUsername: xtreamCatchup?.username || '',
      xtreamCatchupPassword: xtreamCatchup?.password || '',
    });
    console.log('[SourcesTab] Editing source, existing UA:', source.user_agent);
    setEditingId(source.id);
    setShowAddForm(true);
    setError(null);
  }

  function handleDeleteClick(id: string, sourceName: string) {
    if (isDeleting) return;
    setDeleteConfirm({ id, name: sourceName });
  }

  async function confirmDelete() {
    if (!deleteConfirm || !window.storage) return;

    const { id, name } = deleteConfirm;
    setIsDeleting(true);
    setDeleteConfirm(null);

    try {
      console.log('[handleDelete] Starting deletion of source:', id);

      // Mark source as deleted FIRST - prevents sync from writing results after deletion
      markSourceDeleted(id);

      // Clean up all data in SQLite before removing source config
      await clearSourceData(id);
      await clearVodData(id);
      await window.storage.deleteSource(id);

      // Small delay to ensure all async state updates complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Now refresh the source list
      onSourcesChange();

      // Trigger version update for hooks to see the deletion
      incrementVersion();

      console.log('[handleDelete] Deletion completed successfully');
    } catch (error) {
      console.error('[handleDelete] Error during deletion:', error);
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!window.storage) return;
    if (isSaving) return;

    // Helper to detect LAN URLs (RFC 1918 private IPs, localhost, etc)
    function isLanUrl(urlString: string): boolean {
      try {
        const url = new URL(urlString);
        const host = url.hostname;
        if (host === 'localhost' || host === '127.0.0.1') return true;
        if (host.startsWith('10.')) return true;
        if (host.startsWith('192.168.')) return true;
        if (host.startsWith('172.')) {
          const octet = parseInt(host.split('.')[1], 10);
          if (octet >= 16 && octet <= 31) return true;
        }
        if (host.endsWith('.local') || host.endsWith('.lan')) return true;
        return false;
      } catch (e) {
        return false;
      }
    }

    // Validation
    if (!formData.name.trim()) {
      setError(i18n.t('settings:sources.errNameRequired'));
      return;
    }
    // URL is required unless this is a file import
    if (!importedM3U && !formData.url.trim()) {
      setError(i18n.t('settings:sources.errUrlRequired'));
      return;
    }
    if (formData.type === 'xtream' && (!formData.username.trim() || !formData.password.trim())) {
      setError(i18n.t('settings:sources.errXtreamCreds'));
      return;
    }
    if (formData.type === 'stalker' && !formData.mac.trim()) {
      setError(i18n.t('settings:sources.errMacRequired'));
      return;
    }

    // Security check for LAN sources
    const urlToCheck = importedM3U ? '' : formData.url.trim();
    if (urlToCheck && isLanUrl(urlToCheck)) {
      const settingsReq = await window.storage.getSettings();
      const allowLan = settingsReq.data?.allowLanSources === true;
      if (!allowLan) {
        setError(i18n.t('settings:sources.errLanSources'));
        return;
      }
    }

    setIsSaving(true);
    setError(null);

    try {
      const sourceId = editingId || crypto.randomUUID();

      // Helper to detect and fix duplicated URLs (e.g., "urlurl" -> "url")
      function fixDuplicatedUrl(url: string): string {
        if (!url || url.length < 2) return url;
        const half = url.length / 2;
        if (url.substring(0, half) === url.substring(half)) {
          console.log('[SourcesTab] Detected duplicated URL, fixing:', url.substring(0, half));
          return url.substring(0, half);
        }
        return url;
      }

      const xtreamCatchup = formData.type === 'm3u' && formData.xtreamCatchupUrl.trim()
        ? {
            url: formData.xtreamCatchupUrl.trim(),
            username: formData.xtreamCatchupUsername.trim(),
            password: formData.xtreamCatchupPassword.trim(),
          }
        : undefined;

      const source: Source = {
        id: sourceId,
        name: formData.name.trim(),
        type: formData.type,
        url: importedM3U ? `imported:${formData.name.trim()}` : formData.url.trim(),
        enabled: true,
        username: formData.type === 'xtream' ? formData.username.trim() : undefined,
        password: formData.type === 'xtream' ? formData.password.trim() : undefined,
        mac: formData.type === 'stalker' ? formData.mac.trim() : undefined,
        auto_load_epg: formData.autoLoadEpg,
        live_tv_only: formData.liveTvOnly,
        vod_only: formData.vodOnly,
        epg_url: fixDuplicatedUrl(formData.epgUrl.trim()) || undefined,
        additional_epg_urls: formData.additionalEpgUrls.length > 0 ? formData.additionalEpgUrls : undefined,
        user_agent: formData.userAgent.trim() || undefined,
        epg_timeshift_hours: formData.epgTimeshiftHours || undefined,
        custom_refresh_interval: formData.customRefreshInterval || undefined,
        custom_vod_refresh_interval: formData.customVodRefreshInterval || undefined,
        backup_macs: formData.type === 'stalker' && formData.backupMacs.length > 0 ? formData.backupMacs : undefined,
        backup_credentials: formData.type === 'xtream' && formData.backupCredentials.length > 0 ? formData.backupCredentials : undefined,
        backup_urls: formData.backupUrls.length > 0 ? formData.backupUrls : undefined,
        display_order: formData.display_order,
        advanced_epg_matching: formData.advancedEpgMatching || undefined,
        disable_short_epg: formData.type === 'stalker' ? formData.disableShortEpg : undefined,
        ...(xtreamCatchup ? { xtream_catchup: xtreamCatchup } : {}),
      };

      console.log('[SourcesTab] Saving source with UA:', source.user_agent);
      console.log('[SourcesTab] Saving source epg_url:', source.epg_url, 'length:', source.epg_url?.length);

      // If stalker, clear any cached tokens for this source so fresh settings are used
      if (formData.type === 'stalker') {
        StalkerClient.clearTokenCache(sourceId);
      }

      // If swap occurred, trigger resync after save
      const needsResync = formData.pendingSwap;

      const result = await window.storage.saveSource(source);
      if (result.error) {
        setError(translateNativeError(result.error) || result.error);
        return;
      }

      // For file imports, store channels directly in the database
      if (importedM3U) {
        const parsed = parseM3U(importedM3U.rawContent, sourceId);

        // If Xtream catchup is configured, enrich channels with catchup data
        if (xtreamCatchup) {
          try {
            const { enrichM3uWithXtreamCatchup } = await import('../../db/sync');
            const enrichedChannels = await enrichM3uWithXtreamCatchup(
              source as any,
              parsed.channels,
              () => {}
            );
            (parsed as any).channels = enrichedChannels;
          } catch (err) {
            console.warn('[SourcesTab] Failed to enrich imported M3U with Xtream catchup:', err);
          }
        }

        await db.transaction('rw', [db.channels, db.categories, db.sourcesMeta], async () => {
          if (parsed.channels.length > 0) {
            // Cast to any to bypass Channel vs StoredChannel type mismatch
            await db.channels.bulkPut(parsed.channels as any[]);
          }
          if (parsed.categories.length > 0) {
            await db.categories.bulkPut(parsed.categories);
          }
          await db.sourcesMeta.put({
            source_id: sourceId,
            epg_url: parsed.epgUrl ?? undefined,
            last_synced: new Date(),
            channel_count: parsed.channels.length,
            category_count: parsed.categories.length,
            expiry_date: (source as any)._xtream_expiry,
            active_cons: (source as any)._xtream_active_cons,
            max_connections: (source as any)._xtream_max_connections,
          });
        });
      }

      setShowAddForm(false);
      setFormData(emptyForm);
      setEditingId(null);
      setImportedM3U(null);
      onSourcesChange();
      incrementVersion(); // Notify listeners of new source

      // Immediately apply the source-level EPG timeshift to sourcesMeta so the
      // programs_effective view picks it up without requiring a full resync.
      // The view JOINs sourcesMeta live on every query, so this is instant.
      if (editingId) {
        try {
          const dbInstance = await (db as any).dbPromise;
          await dbInstance.execute(
            `UPDATE sourcesMeta SET epg_timeshift_hours = $1 WHERE source_id = $2`,
            [source.epg_timeshift_hours ?? 0, sourceId]
          );
          // Notify all program hooks (useCurrentProgram, usePrograms, useProgramsInRange,
          // useAllPrograms) to re-run so the shifted times appear immediately.
          dbEvents.notify('programs', 'update');
        } catch (e) {
          // sourcesMeta row may not exist yet for new sources — harmless, sync will create it
          console.warn('[SourcesTab] Could not update sourcesMeta epg_timeshift_hours:', e);
        }
      }

      // Trigger auto-resync if swap occurred
      if (needsResync) {
        console.log('[SourcesTab] Triggering auto-resync due to credential swap');
        // Pass the updated source object directly to avoid race conditions
        setTimeout(() => handleSourceSync(sourceId, source), 100);
      }
    } catch (err: any) {
      console.error('[SourcesTab] Error saving source:', err);
      setError(err?.message || i18n.t('settings:sources.errSaveSource'));
    } finally {
      setIsSaving(false);
    }
  }

  // Backup Credential Handlers
  function handleAddBackupMac() {
    setShowBackupMacInput(true);
    setNewBackupMac('');
  }

  function confirmAddBackupMac() {
    if (newBackupMac && newBackupMac.trim()) {
      setFormData({
        ...formData,
        backupMacs: [...formData.backupMacs, newBackupMac.trim()]
      });
      setShowBackupMacInput(false);
      setNewBackupMac('');
    }
  }

  function cancelAddBackupMac() {
    setShowBackupMacInput(false);
    setNewBackupMac('');
  }

  function handleAddBackupCredential() {
    setShowBackupCredInput(true);
    setNewBackupUser('');
    setNewBackupPass('');
  }

  function confirmAddBackupCredential() {
    if (newBackupUser && newBackupUser.trim() && newBackupPass && newBackupPass.trim()) {
      setFormData({
        ...formData,
        backupCredentials: [
          ...formData.backupCredentials,
          { username: newBackupUser.trim(), password: newBackupPass.trim() }
        ]
      });
      setShowBackupCredInput(false);
      setNewBackupUser('');
      setNewBackupPass('');
    }
  }

  function cancelAddBackupCredential() {
    setShowBackupCredInput(false);
    setNewBackupUser('');
    setNewBackupPass('');
  }

  // Additional EPG URL Handlers
  function handleAddAdditionalEpg() {
    setShowAdditionalEpgInput(true);
    setNewAdditionalEpgUrl('');
  }

  function confirmAddAdditionalEpg() {
    if (newAdditionalEpgUrl && newAdditionalEpgUrl.trim()) {
      setFormData({
        ...formData,
        additionalEpgUrls: [...formData.additionalEpgUrls, newAdditionalEpgUrl.trim()]
      });
      setShowAdditionalEpgInput(false);
      setNewAdditionalEpgUrl('');
    }
  }

  function cancelAddAdditionalEpg() {
    setShowAdditionalEpgInput(false);
    setNewAdditionalEpgUrl('');
  }

  function handleDeleteAdditionalEpg(index: number) {
    const newUrls = formData.additionalEpgUrls.filter((_, i) => i !== index);
    setFormData({ ...formData, additionalEpgUrls: newUrls });
  }

  // Backup URL Handlers
  function handleAddBackupUrl() {
    setShowBackupUrlInput(true);
    setNewBackupUrl('');
  }

  function confirmAddBackupUrl() {
    if (newBackupUrl && newBackupUrl.trim()) {
      const urls = newBackupUrl
        .split('\n')
        .map(u => u.trim())
        .filter(u => u.length > 0);
      if (urls.length > 0) {
        setFormData({
          ...formData,
          backupUrls: [...formData.backupUrls, ...urls]
        });
      }
      setShowBackupUrlInput(false);
      setNewBackupUrl('');
    }
  }

  function cancelAddBackupUrl() {
    setShowBackupUrlInput(false);
    setNewBackupUrl('');
  }

  function handleDeleteBackupUrl(index: number) {
    const newUrls = formData.backupUrls.filter((_, i) => i !== index);
    setFormData({ ...formData, backupUrls: newUrls });
    // Clear test status for deleted index and shift others
    const newStatus = new Map(backupTestStatus);
    newStatus.delete(index);
    const shifted = new Map<number, 'idle' | 'testing' | 'success' | 'error'>();
    newStatus.forEach((val, key) => {
      if (key > index) {
        shifted.set(key - 1, val);
      } else {
        shifted.set(key, val);
      }
    });
    setBackupTestStatus(shifted);
  }

  async function handleTestBackupUrl(index: number, url: string) {
    setBackupTestStatus(prev => new Map(prev).set(index, 'testing'));

    try {
      let success = false;

      if (formData.type === 'xtream') {
        if (!formData.username || !formData.password) {
          setBackupTestStatus(prev => new Map(prev).set(index, 'error'));
          return;
        }
        const client = new XtreamClient(
          { baseUrl: url, username: formData.username, password: formData.password, userAgent: formData.userAgent },
          'test'
        );
        const result = await client.testConnection();
        success = result.success;
      } else if (formData.type === 'stalker') {
        if (!formData.mac) {
          setBackupTestStatus(prev => new Map(prev).set(index, 'error'));
          return;
        }
        const client = new StalkerClient(
          { baseUrl: url, mac: formData.mac, userAgent: formData.userAgent },
          'test'
        );
        const result = await client.testConnection();
        success = result.success;
      } else {
        // M3U: try a lightweight fetch
        const finalUa = formData.userAgent.trim() || 'VLC/3.0.18 LibVLC/3.0.18';
        if (window.fetchProxy) {
          const result = await window.fetchProxy.fetch(url, {
            headers: { 'User-Agent': finalUa }
          });
          success = !!(result.success && result.data && result.data.ok);
        } else {
          const response = await fetch(url, {
            method: 'HEAD',
            headers: { 'User-Agent': finalUa }
          });
          success = response.ok;
        }
      }

      setBackupTestStatus(prev => new Map(prev).set(index, success ? 'success' : 'error'));
    } catch {
      setBackupTestStatus(prev => new Map(prev).set(index, 'error'));
    }
  }

  function handleSwapCredential(type: 'stalker' | 'xtream', index: number) {
    if (type === 'stalker') {
      const currentMac = formData.mac;
      const backupMac = formData.backupMacs[index];

      const newBackups = [...formData.backupMacs];
      newBackups[index] = currentMac;

      setFormData({
        ...formData,
        mac: backupMac,
        backupMacs: newBackups,
        pendingSwap: true
      });
    } else {
      const currentCreds = { username: formData.username, password: formData.password };
      const backupCreds = formData.backupCredentials[index];

      const newBackups = [...formData.backupCredentials];
      newBackups[index] = currentCreds;

      setFormData({
        ...formData,
        username: backupCreds.username,
        password: backupCreds.password,
        backupCredentials: newBackups,
        pendingSwap: true
      });
    }
  }

  function handleDeleteBackup(type: 'stalker' | 'xtream', index: number) {
    setDeleteBackupConfirm({ type, index });
  }

  function confirmDeleteBackup() {
    if (!deleteBackupConfirm) return;
    const { type, index } = deleteBackupConfirm;

    if (type === 'stalker') {
      const newBackups = formData.backupMacs.filter((_, i) => i !== index);
      setFormData({ ...formData, backupMacs: newBackups });
    } else {
      const newBackups = formData.backupCredentials.filter((_, i) => i !== index);
      setFormData({ ...formData, backupCredentials: newBackups });
    }
    setDeleteBackupConfirm(null);
  }

  function handleCancel() {
    setShowAddForm(false);
    setFormData(emptyForm);
    setEditingId(null);
    setImportedM3U(null);
    setError(null);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncResults(null);
    setSyncError(null);
    setSyncStatusMsg(i18n.t('common:initializing'));
    try {
      const results = await syncAllSources(setSyncStatusMsg, epgSyncConcurrency);
      setSyncResults(results);
      // Trigger category refresh after sync completes
      incrementVersion();
    } catch (err) {
      const msg = err instanceof Error ? err.message : i18n.t('common:channelSyncFailed');
      console.error('Sync error:', err);
      setSyncError(msg);
      useToastStore.getState().addToast(msg, 'error');
    } finally {
      setSyncing(false);
      setSyncStatusMsg(null);
      // Refresh global EPG links to pick up post-sync results
      await loadGlobalEpgLinks();
    }
  }

  async function handleVodSync() {
    setVodSyncing(true);
    setVodSyncResults(null);
    setSyncError(null);
    // VOD sync progress not yet implemented in UI store/db layer fully like channels
    try {
      const results = await syncAllVod();
      setVodSyncResults(results);
    } catch (err) {
      const msg = err instanceof Error ? err.message : i18n.t('common:vodSyncFailed');
      console.error('VOD sync error:', err);
      setSyncError(msg);
      useToastStore.getState().addToast(msg, 'error');
    } finally {
      setVodSyncing(false);
    }
  }

  // Per-source sync handlers
  async function handleSourceSync(sourceId: string, overrideSource?: Source) {
    let source = overrideSource;
    if (!source) {
      source = sources.find(s => s.id === sourceId);
    }

    if (!source) return;

    console.log('[SourcesTab] handleSourceSync - source.epg_url:', source.epg_url, 'length:', source.epg_url?.length);

    setSyncingSourceId(sourceId);
    setSyncStatusMsg(i18n.t('common:starting'));
    try {
      const result = await syncSource(source, setSyncStatusMsg);
      // Show success/failure notification
      if (result.success) {
        console.log(`Source ${source.name}: ${result.channelCount} channels synced`);
      } else {
        console.error(`Source ${source.name} sync failed:`, result.error);
        useToastStore.getState().addToast(i18n.t('settings:sources.syncFailedToast', { name: source.name, error: translateNativeError(result.error) || result.error }), 'error');
      }

      // Post-sync: apply global EPG links (primary EPG just cleared everything)
      try {
        setSyncStatusMsg(i18n.t('common:updatingGlobalEpg'));
        const channels = await db.channels.where('source_id').equals(sourceId).toArray() as Channel[];
        const globalCount = await applyGlobalEpgToSource(source, channels, (msg) => setSyncStatusMsg(msg));
        if (globalCount > 0) {
          console.log(`Source ${source.name}: ${globalCount} programs from global EPG`);
        }
        // Refresh global EPG links state so cards show updated lastSyncResult
        await loadGlobalEpgLinks();
      } catch (epgErr) {
        console.error(`Source ${source.name}: global EPG apply failed:`, epgErr);
      }

      onSourcesChange(); // Refresh to show updated counts
      incrementVersion(); // Trigger category refresh
    } catch (err) {
      console.error('Per-source sync error:', err);
    } finally {
      setSyncingSourceId(null);
      setSyncStatusMsg(null);
    }
  }

  async function handleSourceVodSync(sourceId: string) {
    const source = sources.find(s => s.id === sourceId);
    if (!source || (source.type !== 'xtream' && source.type !== 'stalker') || source.live_tv_only) return;

    setVodSyncingSourceId(sourceId);
    try {
      const result = await syncVodForSource(source);
      if (result.success) {
        console.log(`Source ${source.name}: ${result.movieCount} movies, ${result.seriesCount} series synced`);
      } else {
        console.error(`Source ${source.name} VOD sync failed:`, result.error);
        useToastStore.getState().addToast(i18n.t('settings:sources.vodSyncFailedToast', { name: source.name, error: translateNativeError(result.error) || result.error }), 'error');
      }
      onSourcesChange(); // Refresh to show updated counts
    } catch (err) {
      console.error('Per-source VOD sync error:', err);
    } finally {
      setVodSyncingSourceId(null);
    }
  }

  // Enable/disable toggle handler
  async function handleToggleEnabled(sourceId: string) {
    const source = sources.find(s => s.id === sourceId);
    if (!source || !window.storage) return;

    const updated = { ...source, enabled: !source.enabled };
    await window.storage.saveSource(updated);

    // Increment version to trigger all useEnabledSources hooks to refresh
    incrementVersion();

    // Trigger parent refresh
    onSourcesChange();
  }

  // --- Global EPG Handlers ---
  function handleAddEpg() {
    setEpgFormData({ name: '', url: '', sourceIds: [], saveEntireEpg: false });
    setEditingEpgId(null);
    setShowAddEpgForm(true);
    setEpgFormError(null);
  }

  function handleEditEpg(epg: GlobalEpgLink) {
    setEpgFormData({
      name: epg.name,
      url: epg.url,
      sourceIds: [...epg.sourceIds],
      saveEntireEpg: !!epg.saveEntireEpg
    });
    setEditingEpgId(epg.id);
    setShowAddEpgForm(true);
    setEpgFormError(null);
  }

  function handleDeleteEpgClick(epg: GlobalEpgLink) {
    setDeleteEpgConfirm(epg);
  }

  async function confirmDeleteEpg() {
    if (!deleteEpgConfirm || !window.storage) return;
    const newLinks = globalEpgLinks.filter(e => e.id !== deleteEpgConfirm.id);
    setGlobalEpgLinks(newLinks);
    const linkId = deleteEpgConfirm.id;
    setDeleteEpgConfirm(null);
    await window.storage.updateSettings({ globalEpgLinks: newLinks });
    try {
      await cleanupGlobalEpgCache(linkId);
    } catch (e) {
      console.warn('[Global EPG] Failed to cleanup cache database on delete:', e);
    }
  }

  function handleCancelEpg() {
    setShowAddEpgForm(false);
    setEpgFormData({ name: '', url: '', sourceIds: [], saveEntireEpg: false });
    setEditingEpgId(null);
    setEpgFormError(null);
  }

  async function handleSubmitEpg(e: React.FormEvent) {
    e.preventDefault();
    if (!window.storage) return;

    if (!epgFormData.name.trim()) {
      setEpgFormError(i18n.t('settings:sources.errNameRequired'));
      return;
    }
    if (!epgFormData.url.trim()) {
      setEpgFormError(i18n.t('settings:sources.errEpgUrlRequired'));
      return;
    }
    if (epgFormData.sourceIds.length === 0) {
      setEpgFormError(i18n.t('settings:sources.errSelectSource'));
      return;
    }

    const linkId = editingEpgId || crypto.randomUUID();
    const existingLink = editingEpgId ? globalEpgLinks.find(e => e.id === editingEpgId) : null;
    
    const newLink: GlobalEpgLink = {
      id: linkId,
      name: epgFormData.name.trim(),
      url: epgFormData.url.trim(),
      sourceIds: epgFormData.sourceIds,
      saveEntireEpg: epgFormData.saveEntireEpg,
      lastSynced: existingLink?.lastSynced,
      lastSyncResult: existingLink?.lastSyncResult,
      display_order: existingLink?.display_order,
    };

    const newLinks = editingEpgId
      ? globalEpgLinks.map(e => (e.id === editingEpgId ? newLink : e))
      : [...globalEpgLinks, newLink];

    setGlobalEpgLinks(newLinks);
    setShowAddEpgForm(false);
    setEpgFormData({ name: '', url: '', sourceIds: [], saveEntireEpg: false });
    setEditingEpgId(null);
    setEpgFormError(null);
    await window.storage.updateSettings({ globalEpgLinks: newLinks });
  }

  function toggleEpgSourceId(sourceId: string) {
    setEpgFormData(prev => ({
      ...prev,
      sourceIds: prev.sourceIds.includes(sourceId)
        ? prev.sourceIds.filter(id => id !== sourceId)
        : [...prev.sourceIds, sourceId],
    }));
  }

  /**
   * Reorder the global EPG links by moving the link at `fromIndex` (in the
   * SORTED list) to `toIndex`, then rewrite explicit sequential display_orders.
   *
   * MUST operate on sortedEpgLinks, not globalEpgLinks: the rendered list is
   * the sorted array, so the old code indexed into the unsorted array with the
   * visible index and moved a random, unrelated link whenever insertion order
   * differed from display_order (the "changes randomly" bug in issue #171).
   * Rewriting gap-free sequential orders also removes the
   * undefined/MAX_SAFE_INTEGER fallback mess.
   */
  async function reorderEpgLinks(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex || !window.storage) return;
    const sorted = [...sortedEpgLinks];
    const [moved] = sorted.splice(fromIndex, 1);
    sorted.splice(toIndex, 0, moved);
    const orderById = new Map(sorted.map((e, i) => [e.id, i]));
    const newLinks = globalEpgLinks.map(e => ({
      ...e,
      display_order: orderById.get(e.id) ?? e.display_order,
    }));
    setGlobalEpgLinks(newLinks);
    await window.storage.updateSettings({ globalEpgLinks: newLinks });
  }

  async function moveEpgUp(index: number) {
    if (index <= 0 || !window.storage) return;
    await reorderEpgLinks(index, index - 1);
  }

  async function moveEpgDown(index: number) {
    if (index >= sortedEpgLinks.length - 1 || !window.storage) return;
    await reorderEpgLinks(index, index + 1);
  }

  async function handleSyncEpg(epg: GlobalEpgLink) {
    if (syncingEpgId || syncingAllEpg) return;
    setSyncingEpgId(epg.id);
    try {
      const count = await syncGlobalEpgLinkStandalone(epg, (msg) => {
        console.log(`[Global EPG] ${epg.name}: ${msg}`);
      });
      // Refresh lastSynced and results from settings
      if (window.storage) {
        const result = await window.storage.getSettings();
        if (result.data?.globalEpgLinks) {
          setGlobalEpgLinks(result.data.globalEpgLinks);
        }
      }
      console.log(`[Global EPG] Synced ${epg.name}: ${count} programs inserted`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Global EPG] Failed to sync ${epg.name}:`, err);
      useToastStore.getState().addToast(i18n.t('settings:sources.epgSyncFailedToast', { name: epg.name, error: msg }), 'error');
    } finally {
      setSyncingEpgId(null);
    }
  }

  async function handleSyncAllEpg() {
    if (syncingEpgId || syncingAllEpg || globalEpgLinks.length === 0) return;
    setSyncingAllEpg(true);
    try {
      for (const epg of globalEpgLinks) {
        setSyncingEpgId(epg.id);
        try {
          const count = await syncGlobalEpgLinkStandalone(epg);
          console.log(`[Global EPG] Synced ${epg.name}: ${count} programs inserted`);
        } catch (err) {
          console.error(`[Global EPG] Failed to sync ${epg.name}:`, err);
        }
      }
      // Refresh lastSynced from settings
      if (window.storage) {
        const result = await window.storage.getSettings();
        if (result.data?.globalEpgLinks) {
          setGlobalEpgLinks(result.data.globalEpgLinks);
        }
      }
    } finally {
      setSyncingEpgId(null);
      setSyncingAllEpg(false);
    }
  }

  // Format time since last sync
  function formatLastSynced(timestamp?: number): string {
    if (!timestamp) return i18n.t('time:neverSynced');
    const diffMs = Date.now() - timestamp;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return i18n.t('time:justNow');
    if (diffMins < 60) return i18n.t('time:minuteAgo', { count: diffMins });
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return i18n.t('time:hourAgo', { count: diffHours });
    const diffDays = Math.floor(diffHours / 24);
    return i18n.t('time:dayAgo', { count: diffDays });
  }

  // --- @dnd-kit Drag and Drop Handlers for Sources ---
  const sourceSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleSourceDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sortedSources.findIndex((s) => s.id === active.id);
    const newIndex = sortedSources.findIndex((s) => s.id === over.id);

    if (oldIndex === -1 || newIndex === -1) return;

    const newSources = arrayMove(sortedSources, oldIndex, newIndex);

    if (!window.storage) return;

    for (let i = 0; i < newSources.length; i++) {
      const sourceToSave = newSources[i];
      if (sourceToSave.display_order !== i) {
        await window.storage.saveSource({ ...sourceToSave, display_order: i });
      }
    }

    onSourcesChange();
    incrementVersion();
  };

  // --- @dnd-kit Drag and Drop Handlers for Global EPG Links ---
  const epgSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleEpgDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sortedEpgLinks.findIndex((e) => e.id === active.id);
    const newIndex = sortedEpgLinks.findIndex((e) => e.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    await reorderEpgLinks(oldIndex, newIndex);
  };


  return (
    <div className="settings-tab-content">
      {/* Sub-tabs */}
      <div className="sub-tabs" style={{ display: 'flex', gap: '2px', marginBottom: '16px', borderBottom: '1px solid var(--surface-border)' }}>
        <button
          className={`sub-tab-btn ${activeSubTab === 'source' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('source')}
          style={{
            padding: '10px 20px',
            background: activeSubTab === 'source' ? 'var(--surface-color)' : 'transparent',
            border: 'none',
            borderBottom: activeSubTab === 'source' ? '2px solid var(--accent-primary, #00d4ff)' : '2px solid transparent',
            color: activeSubTab === 'source' ? 'var(--text-primary)' : 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: '0.9rem',
            fontWeight: 500,
            transition: 'all 0.2s ease',
          }}
        >
          {i18n.t('settings:sources.tabs.source')}
        </button>
        <button
          className={`sub-tab-btn ${activeSubTab === 'epg' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('epg')}
          style={{
            padding: '10px 20px',
            background: activeSubTab === 'epg' ? 'var(--surface-color)' : 'transparent',
            border: 'none',
            borderBottom: activeSubTab === 'epg' ? '2px solid var(--accent-primary, #00d4ff)' : '2px solid transparent',
            color: activeSubTab === 'epg' ? 'var(--text-primary)' : 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: '0.9rem',
            fontWeight: 500,
            transition: 'all 0.2s ease',
          }}
        >
          {i18n.t('settings:sources.tabs.epg')}
        </button>
        <button
          className={`sub-tab-btn ${activeSubTab === 'refresh' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('refresh')}
          style={{
            padding: '10px 20px',
            background: activeSubTab === 'refresh' ? 'var(--surface-color)' : 'transparent',
            border: 'none',
            borderBottom: activeSubTab === 'refresh' ? '2px solid var(--accent-primary, #00d4ff)' : '2px solid transparent',
            color: activeSubTab === 'refresh' ? 'var(--text-primary)' : 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: '0.9rem',
            fontWeight: 500,
            transition: 'all 0.2s ease',
          }}
        >
          {i18n.t('settings:sources.tabs.refresh')}
        </button>
        <button
          className={`sub-tab-btn ${activeSubTab === 'global_ua' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('global_ua')}
          style={{
            padding: '10px 20px',
            background: activeSubTab === 'global_ua' ? 'var(--surface-color)' : 'transparent',
            border: 'none',
            borderBottom: activeSubTab === 'global_ua' ? '2px solid var(--accent-primary, #00d4ff)' : '2px solid transparent',
            color: activeSubTab === 'global_ua' ? 'var(--text-primary)' : 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: '0.9rem',
            fontWeight: 500,
            transition: 'all 0.2s ease',
          }}
        >
          {i18n.t('settings:sources.tabs.globalUa')}
        </button>
      </div>

      {activeSubTab === 'source' && (
        <>
          {/* Sources List */}
          <div className="settings-section">
            <div className="section-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h3>{i18n.t('settings:sources.sourcesTitle')}</h3>
                <button
                  className={`sources-hide-toggle${hideDisabledSources ? ' active' : ''}`}
                  onClick={() => setHideDisabledSources(!hideDisabledSources)}
                  title={i18n.t('settings:channelManager.hideDisabled')}
                >
                  {hideDisabledSources
                    ? '👁 ' + i18n.t('common:showAll')
                    : '👁‍🗨 ' + i18n.t('settings:channelManager.hideDisabled')}
                </button>
              </div>
              <div className="section-actions">
                <button
                  className="sync-btn"
                  onClick={handleSync}
                  disabled={syncing || sources.length === 0}
                  style={{ minWidth: '140px' }}
                >
                  {syncing ? (syncStatusMsg || i18n.t('common:syncing')) : i18n.t('settings:sources.syncChannels')}
                </button>
                <button
                  className="sync-btn"
                  onClick={handleVodSync}
                  disabled={vodSyncing || !hasVodSource}
                >
                  {vodSyncing ? i18n.t('common:syncing') : i18n.t('settings:sources.syncMoviesSeries')}
                </button>
                <button className="add-btn" onClick={handleAdd}>{i18n.t('settings:sources.addPlaylist')}</button>
              </div>
        </div>

        {syncError && (
          <div className="sync-error">{syncError}</div>
        )}

        {sources.length === 0 ? (
          <div className="empty-state">
            <p>{i18n.t('settings:sources.noSources')}</p>
            <p className="hint">{i18n.t('settings:sources.noSourcesHint')}</p>
          </div>
        ) : visibleSources.length === 0 ? (
          <div className="empty-state">
            <p>{i18n.t('settings:channelManager.hideDisabled')}</p>
            <p className="hint">{i18n.t('common:showAll')}</p>
          </div>
        ) : (
          <DndContext
            sensors={sourceSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleSourceDragEnd}
          >
            <SortableContext
              items={visibleSources.map((s) => s.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="sources-list sortable-list">
                {visibleSources.map((source) => {
                  const meta = syncStatus.find(s => s.source_id === source.id);
                  return (
                    <SortableSourceItem
                      key={source.id}
                      source={source}
                      meta={meta}
                      syncingSourceId={syncingSourceId}
                      vodSyncingSourceId={vodSyncingSourceId}
                      syncStatusMsg={syncStatusMsg}
                      isDeleting={isDeleting}
                      isExpiryWarning={isExpiryWarning}
                      formatExpiryDate={formatExpiryDate}
                      formatTimeAgo={formatTimeAgo}
                      handleToggleEnabled={handleToggleEnabled}
                      handleSourceSync={handleSourceSync}
                      handleSourceVodSync={handleSourceVodSync}
                      setCategoryManagerSource={setCategoryManagerSource}
                      handleEdit={handleEdit}
                      handleDeleteClick={handleDeleteClick}
                    />
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Add/Edit Form */}
      {showAddForm && createPortal(
        <div className="source-form-overlay">
          <form className="source-form" onSubmit={handleSubmit}>
            <h3>{editingId ? i18n.t('settings:sources.editSource') : i18n.t('settings:sources.addSource')}</h3>

            {error && <div className="form-error">{error}</div>}

            <div className="form-group">
              <label>{i18n.t('settings:sources.name')}</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder={i18n.t('settings:sources.namePlaceholder')}
              />
            </div>

            {/* Type selector - hidden for file imports */}
            {!importedM3U && (
              <div className="form-group">
                <label>{i18n.t('settings:sources.type')}</label>
                <div className="type-selector">
                  <button
                    type="button"
                    className={formData.type === 'm3u' ? 'active' : ''}
                    onClick={() => setFormData({ ...formData, type: 'm3u' })}
                  >
                    {i18n.t('settings:sources.m3uPlaylist')}
                  </button>
                  <button
                    type="button"
                    className={formData.type === 'xtream' ? 'active' : ''}
                    onClick={() => setFormData({ ...formData, type: 'xtream' })}
                  >
                    {i18n.t('settings:sources.xtreamCodes')}
                  </button>
                  <button
                    type="button"
                    className={formData.type === 'stalker' ? 'active' : ''}
                    onClick={() => setFormData({ ...formData, type: 'stalker' })}
                  >
                    {i18n.t('settings:sources.stalkerPortal')}
                  </button>
                </div>
              </div>
            )}

            {/* URL field for Xtream/Stalker sources */}
            {(formData.type === 'xtream' || formData.type === 'stalker') && (
              <div className="form-group">
                <label>{i18n.t('settings:sources.hostUrl')}</label>
                <input
                  type="text"
                  value={formData.url}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (formData.type === 'xtream') {
                      try {
                        const urlObj = new URL(value);
                        const u = urlObj.searchParams.get('username');
                        const p = urlObj.searchParams.get('password');
                        if (u && p && (value.includes('/get.php') || value.includes('/player_api.php'))) {
                          setFormData({ ...formData, url: `${urlObj.protocol}//${urlObj.host}/`, username: u, password: p });
                          return;
                        }
                      } catch {}
                    }
                    setFormData({ ...formData, url: value });
                  }}
                  placeholder="http://provider.com:8080"
                />
              </div>
            )}

            {/* M3U: URL or File import */}
            {formData.type === 'm3u' && !importedM3U && (
              <div className="form-group">
                <label>{i18n.t('settings:sources.playlistUrl')}</label>
                <input
                  type="text"
                  value={formData.url}
                  onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                  placeholder="http://example.com/playlist.m3u"
                />
                <div className="or-divider">
                  <span>{i18n.t('settings:sources.or')}</span>
                </div>
                <button
                  type="button"
                  className="import-btn"
                  onClick={handleImportM3U}
                >
                  {i18n.t('settings:sources.importFromFile')}
                </button>
              </div>
            )}

            {/* Import info for file imports */}
            {formData.type === 'm3u' && importedM3U && (
              <div className="form-group import-info">
                <label>{i18n.t('settings:sources.importedFile')}</label>
                <div className="import-summary">
                  <span>{i18n.t('settings:sources.channelsCount', { count: importedM3U.channels })}</span>
                  <span>{i18n.t('settings:sources.categoriesCount', { count: importedM3U.categories })}</span>
                  {importedM3U.epgUrl && <span>{i18n.t('settings:sources.epgUrlDetected')}</span>}
                </div>
                <button
                  type="button"
                  className="change-file-btn"
                  onClick={() => setImportedM3U(null)}
                >
                  {i18n.t('settings:sources.useUrlInstead')}
                </button>
              </div>
            )}

            {/* Xtream Catchup (for M3U sources with Xtream catchup support) */}
            {formData.type === 'm3u' && (
              <details className="form-details">
                <summary className="form-details-summary">{i18n.t('settings:sources.xtreamCatchup')}</summary>
                <div className="form-details-content">
                  <span className="hint" style={{ marginBottom: '8px', display: 'block' }}>
                    {i18n.t('settings:sources.xtreamCatchupHint')}
                  </span>
                  <div className="form-group">
                    <label>{i18n.t('settings:sources.xcServerUrl')}</label>
                    <input
                      type="text"
                      value={formData.xtreamCatchupUrl}
                      onChange={(e) => setFormData({ ...formData, xtreamCatchupUrl: e.target.value })}
                      placeholder="http://provider.com:8080"
                    />
                  </div>
                  <div className="form-group">
                    <label>{i18n.t('settings:sources.xcUsername')}</label>
                    <input
                      type="text"
                      value={formData.xtreamCatchupUsername}
                      onChange={(e) => setFormData({ ...formData, xtreamCatchupUsername: e.target.value })}
                      placeholder={i18n.t('settings:sources.usernamePlaceholder')}
                    />
                  </div>
                  <div className="form-group">
                    <label>{i18n.t('settings:sources.xcPassword')}</label>
                    <input
                      type="password"
                      value={formData.xtreamCatchupPassword}
                      onChange={(e) => setFormData({ ...formData, xtreamCatchupPassword: e.target.value })}
                      placeholder={i18n.t('settings:sources.passwordPlaceholder')}
                    />
                  </div>
                </div>
              </details>
            )}

            {formData.type === 'stalker' && (
              <>
                <div className="form-group">
                  <label>{i18n.t('settings:sources.macAddress')}</label>
                  <input
                    type="text"
                    value={formData.mac}
                    onChange={(e) => setFormData({ ...formData, mac: e.target.value })}
                    placeholder="00:1A:79:XX:XX:XX"
                  />
                </div>

                {/* Backup MACs */}
                <div className="form-group backup-section">
                  <label>{i18n.t('settings:sources.backupMacs')}</label>
                  <div className="backup-list">
                    {formData.backupMacs.map((mac, index) => (
                      <div key={index} className="backup-item">
                        <span className="backup-val">{mac}</span>
                        <div className="backup-actions">
                          <button
                            type="button"
                            className="swap-btn"
                            onClick={() => handleSwapCredential('stalker', index)}
                            title={i18n.t('settings:sources.swapToThisMac')}
                          >
                            {i18n.t('settings:sources.swap')}
                          </button>
                          <button
                            type="button"
                            className="delete-btn"
                            onClick={() => handleDeleteBackup('stalker', index)}
                            title={i18n.t('settings:sources.deleteBackup')}
                          >
                            {i18n.t('common:delete')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {showBackupMacInput ? (
                    <div className="backup-input-row">
                      <input
                        type="text"
                        value={newBackupMac}
                        onChange={(e) => setNewBackupMac(e.target.value)}
                        placeholder="00:1A:79:XX:XX:XX"
                        className="backup-input"
                        autoFocus
                      />
                      <div className="backup-input-actions">
                        <button
                          type="button"
                          className="confirm-btn"
                          onClick={confirmAddBackupMac}
                        >
                          {i18n.t('common:add')}
                        </button>
                        <button
                          type="button"
                          className="cancel-btn"
                          onClick={cancelAddBackupMac}
                        >
                          {i18n.t('common:cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="add-backup-btn"
                      onClick={handleAddBackupMac}
                    >
                      {i18n.t('settings:sources.addBackupMac')}
                    </button>
                  )}
                </div>
              </>
            )}

            {formData.type === 'xtream' && (
              <>
                <div className="form-group">
                  <label>{i18n.t('settings:sources.username')}</label>
                  <input
                    type="text"
                    value={formData.username}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    placeholder={i18n.t('settings:sources.usernamePlaceholder')}
                  />
                </div>
                <div className="form-group">
                  <label>{i18n.t('settings:sources.password')}</label>
                  <div className="password-input-wrapper">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      placeholder={i18n.t('settings:sources.passwordPlaceholder')}
                    />
                    <button
                      type="button"
                      className="password-toggle-btn"
                      onClick={() => setShowPassword(!showPassword)}
                      title={showPassword ? i18n.t('settings:sources.hidePassword') : i18n.t('settings:sources.showPassword')}
                    >
                      {showPassword ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                {/* Backup Credentials */}
                <div className="form-group backup-section">
                  <label>{i18n.t('settings:sources.backupCredentials')}</label>
                  <div className="backup-list">
                    {formData.backupCredentials.map((creds, index) => (
                      <div key={index} className="backup-item">
                        <span className="backup-val">{i18n.t('settings:sources.userPrefix', { username: creds.username })}</span>
                        <div className="backup-actions">
                          <button
                            type="button"
                            className="swap-btn"
                            onClick={() => handleSwapCredential('xtream', index)}
                            title={i18n.t('settings:sources.swapToCreds')}
                          >
                            {i18n.t('settings:sources.swap')}
                          </button>
                          <button
                            type="button"
                            className="delete-btn"
                            onClick={() => handleDeleteBackup('xtream', index)}
                            title={i18n.t('settings:sources.deleteBackup')}
                          >
                            {i18n.t('common:delete')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {showBackupCredInput ? (
                    <div className="backup-input-col">
                      <input
                        type="text"
                        value={newBackupUser}
                        onChange={(e) => setNewBackupUser(e.target.value)}
                        placeholder={i18n.t('settings:sources.backupUsername')}
                        className="backup-input"
                        autoFocus
                      />
                      <div className="password-input-wrapper backup-password-wrapper">
                        <input
                          type={showBackupPassword ? 'text' : 'password'}
                          value={newBackupPass}
                          onChange={(e) => setNewBackupPass(e.target.value)}
                          placeholder={i18n.t('settings:sources.backupPassword')}
                          className="backup-input"
                        />
                        <button
                          type="button"
                          className="password-toggle-btn backup-toggle-btn"
                          onClick={() => setShowBackupPassword(!showBackupPassword)}
                          title={showBackupPassword ? i18n.t('settings:sources.hidePassword') : i18n.t('settings:sources.showPassword')}
                        >
                          {showBackupPassword ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                              <line x1="1" y1="1" x2="23" y2="23" />
                            </svg>
                          ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          )}
                        </button>
                      </div>
                      <div className="backup-input-actions">
                        <button
                          type="button"
                          className="confirm-btn"
                          onClick={confirmAddBackupCredential}
                        >
                          {i18n.t('common:add')}
                        </button>
                        <button
                          type="button"
                          className="cancel-btn"
                          onClick={cancelAddBackupCredential}
                        >
                          {i18n.t('common:cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="add-backup-btn"
                      onClick={handleAddBackupCredential}
                    >
                      {i18n.t('settings:sources.addBackupCreds')}
                    </button>
                  )}
                </div>

                {!isEncryptionAvailable && (
                  <div className="inline-warning">
                    {i18n.t('settings:sources.passwordNoEncryption')}
                  </div>
                )}
              </>
            )}

            {/* EPG Settings */}
            <div className="form-group epg-settings">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={formData.autoLoadEpg}
                  onChange={(e) => setFormData({ ...formData, autoLoadEpg: e.target.checked })}
                />
                {i18n.t('settings:sources.autoLoadEpg')}
              </label>
              <span className="hint">
                {formData.type === 'xtream'
                  ? i18n.t('settings:sources.autoLoadEpgHintXtream')
                  : formData.type === 'stalker'
                    ? i18n.t('settings:sources.autoLoadEpgHintStalker')
                    : i18n.t('settings:sources.autoLoadEpgHintM3U')}
              </span>
            </div>

            {formData.type === 'stalker' && (
              <div className="form-group epg-settings">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={formData.disableShortEpg}
                    onChange={(e) => setFormData({ ...formData, disableShortEpg: e.target.checked })}
                  />
                  {i18n.t('settings:sources.disableShortEpg')}
                </label>
                <span className="hint">
                  {i18n.t('settings:sources.disableShortEpgSub')}
                </span>
              </div>
            )}

            {!formData.autoLoadEpg && (
              <div className="form-group">
                <label>{i18n.t('settings:sources.epgUrlOptional')}</label>
                <input
                  type="text"
                  value={formData.epgUrl}
                  onChange={(e) => setFormData({ ...formData, epgUrl: e.target.value })}
                  placeholder="http://example.com/epg.xml"
                />
                <span className="hint">{i18n.t('settings:sources.xmltvHint')}</span>
              </div>
            )}

            {displayedBuiltEpgUrl && (
              <div className="form-group" style={{ marginBottom: '16px' }}>
                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted, var(--text-muted))' }}>
                  <span style={{ textTransform: 'none' }}>{i18n.t('settings:sources.providerEpgUrl')}</span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(displayedBuiltEpgUrl);
                    }}
                    style={{
                      background: 'var(--surface-glow)',
                      border: '1px solid var(--accent-glow)',
                      color: 'var(--accent-primary, #00d4ff)',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '0.7rem',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      outline: 'none',
                      textTransform: 'none',
                    }}
                  >
                    📋 {i18n.t('common:copyUrl')}
                  </button>
                </label>
                <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                  <input
                    type="text"
                    readOnly
                    value={displayedBuiltEpgUrl}
                    style={{
                      flex: 1,
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--surface-border)',
                      borderRadius: '6px',
                      padding: '8px 12px',
                      color: 'var(--text-secondary)',
                      fontSize: '0.85rem',
                      outline: 'none',
                    }}
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                </div>
                <span className="hint">{i18n.t('settings:sources.builtEpgHint')}</span>
              </div>
            )}

            {/* Additional EPG URLs */}
            <div className="form-group backup-section">
              <label>{i18n.t('settings:sources.additionalEpgUrls')}</label>
              <span className="hint" style={{ display: 'block', marginBottom: '10px' }}>
                {i18n.t('settings:sources.additionalEpgHint')}
              </span>
              <div className="backup-list">
                {formData.additionalEpgUrls.map((url, index) => (
                  <div key={index} className="backup-item">
                    <input
                      type="text"
                      readOnly
                      value={url}
                      className="backup-val epg-url-display"
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                    <div className="backup-actions">
                      <button
                        type="button"
                        className="delete-btn"
                        onClick={() => handleDeleteAdditionalEpg(index)}
                        title={i18n.t('settings:sources.deleteAdditionalEpg')}
                      >
                        {i18n.t('common:delete')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {showAdditionalEpgInput ? (
                <div className="backup-input-row">
                  <input
                    type="text"
                    value={newAdditionalEpgUrl}
                    onChange={(e) => setNewAdditionalEpgUrl(e.target.value)}
                    placeholder="http://example.com/additional-epg.xml"
                    className="backup-input"
                    autoFocus
                  />
                  <div className="backup-input-actions">
                    <button
                      type="button"
                      className="confirm-btn"
                      onClick={confirmAddAdditionalEpg}
                    >
                      {i18n.t('common:add')}
                    </button>
                    <button
                      type="button"
                      className="cancel-btn"
                      onClick={cancelAddAdditionalEpg}
                    >
                      {i18n.t('common:cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="add-backup-btn"
                  onClick={handleAddAdditionalEpg}
                >
                  {i18n.t('settings:sources.addAdditionalEpg')}
                </button>
              )}
            </div>

            {/* Backup URLs */}
            <div className="form-group backup-section">
              <label>{i18n.t('settings:sources.backupUrls')}</label>
              <span className="hint" style={{ display: 'block', marginBottom: '10px' }}>
                {i18n.t('settings:sources.backupUrlsHint')}
              </span>
              <div className="backup-list">
                {formData.backupUrls.map((url, index) => (
                  <div key={index} className="backup-item">
                    <input
                      type="text"
                      readOnly
                      value={url}
                      className="backup-val epg-url-display"
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                    <div className="backup-actions">
                      <button
                        type="button"
                        className={`test-btn ${backupTestStatus.get(index) === 'success' ? 'test-success' : backupTestStatus.get(index) === 'error' ? 'test-error' : ''}`}
                        onClick={() => handleTestBackupUrl(index, url)}
                        disabled={backupTestStatus.get(index) === 'testing'}
                        title={i18n.t('settings:sources.testBackupUrl')}
                      >
                        {backupTestStatus.get(index) === 'testing'
                          ? '...'
                          : backupTestStatus.get(index) === 'success'
                          ? '✓'
                          : backupTestStatus.get(index) === 'error'
                          ? '✕'
                          : i18n.t('common:test')}
                      </button>
                      <button
                        type="button"
                        className="delete-btn"
                        onClick={() => handleDeleteBackupUrl(index)}
                        title={i18n.t('settings:sources.deleteBackupUrl')}
                      >
                        {i18n.t('common:delete')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {showBackupUrlInput ? (
                <div className="backup-input-col">
                  <textarea
                    value={newBackupUrl}
                    onChange={(e) => setNewBackupUrl(e.target.value)}
                    placeholder="http://backup-provider.com:8080&#10;http://backup2.com:8080&#10;http://backup3.com:8080"
                    className="backup-input backup-textarea"
                    rows={4}
                    autoFocus
                  />
                  <div className="backup-input-actions">
                    <button
                      type="button"
                      className="confirm-btn"
                      onClick={confirmAddBackupUrl}
                    >
                      {i18n.t('common:add')}
                    </button>
                    <button
                      type="button"
                      className="cancel-btn"
                      onClick={cancelAddBackupUrl}
                    >
                      {i18n.t('common:cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="add-backup-btn"
                  onClick={handleAddBackupUrl}
                >
                  {i18n.t('settings:sources.addBackupUrl')}
                </button>
              )}
            </div>

            {/* LiveTV Only Setting */}
            <div className="form-group livetv-settings">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={formData.liveTvOnly}
                  onChange={(e) => setFormData({ ...formData, liveTvOnly: e.target.checked })}
                />
                {i18n.t('settings:sources.liveTvOnly')}
              </label>
              <span className="hint">
                {i18n.t('settings:sources.liveTvOnlyHint')}
              </span>
            </div>

            {/* VOD Only Setting */}
            <div className="form-group vod-settings">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={formData.vodOnly}
                  onChange={(e) => setFormData({ ...formData, vodOnly: e.target.checked })}
                />
                {i18n.t('settings:sources.vodOnly')}
              </label>
              <span className="hint">
                {i18n.t('settings:sources.vodOnlyHint')}
              </span>
            </div>

            {/* Advanced EPG Matching */}
            <div className="form-group epg-settings">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={formData.advancedEpgMatching}
                  onChange={(e) => setFormData({ ...formData, advancedEpgMatching: e.target.checked })}
                />
                {i18n.t('settings:sources.advancedEpgMatching')}
              </label>
              <span className="hint">
                {i18n.t('settings:sources.advancedEpgMatchingHint')}
              </span>
            </div>

            <div className="form-group">
              <label>{i18n.t('settings:sources.epgTimeOffset')}</label>
              <input
                type="number"
                value={formData.epgTimeshiftHours}
                onChange={(e) => setFormData({ ...formData, epgTimeshiftHours: parseInt(e.target.value) || 0 })}
                placeholder="0"
                min="-12"
                max="12"
                step="1"
              />
              <span className="hint">{i18n.t('settings:sources.epgTimeOffsetHint')}</span>
            </div>

            <div className="form-group">
              <label>{i18n.t('settings:sources.customRefreshInterval')}</label>
              <input
                type="number"
                value={formData.customRefreshInterval || ''}
                onChange={(e) => setFormData({ ...formData, customRefreshInterval: parseFloat(e.target.value) || 0 })}
                placeholder={i18n.t('settings:sources.useGlobalSetting')}
                min="0"
                step="any"
              />
              <span className="hint">{i18n.t('settings:sources.customRefreshHint')}</span>
            </div>

            {formData.type === 'xtream' && !formData.liveTvOnly && (
              <div className="form-group">
                <label>{i18n.t('settings:sources.customVodRefresh')}</label>
                <input
                  type="number"
                  value={formData.customVodRefreshInterval || ''}
                  onChange={(e) => setFormData({ ...formData, customVodRefreshInterval: parseFloat(e.target.value) || 0 })}
                  placeholder={i18n.t('settings:sources.useGlobalSetting')}
                  min="0"
                  step="any"
                />
                <span className="hint">{i18n.t('settings:sources.customVodRefreshHint')}</span>
              </div>
            )}

            <div className="form-group">
              <label>{i18n.t('settings:sources.userAgentOptional')}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.4rem' }}>
                {PRESET_USER_AGENTS.map((preset) => {
                  const isActive = formData.userAgent.trim() === preset.value;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => setFormData({ ...formData, userAgent: preset.value })}
                      style={{
                        padding: '4px 10px',
                        borderRadius: '16px',
                        fontSize: '0.78rem',
                        fontWeight: isActive ? 600 : 400,
                        background: isActive ? 'var(--primary-color, #3b82f6)' : 'var(--surface-color, rgba(255, 255, 255, 0.06))',
                        color: isActive ? '#fff' : 'var(--text-primary)',
                        border: isActive ? '1px solid var(--primary-color, #3b82f6)' : '1px solid var(--surface-border, rgba(255, 255, 255, 0.15))',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {i18n.t(preset.labelKey, { defaultValue: preset.labelKey })}
                    </button>
                  );
                })}
              </div>
              <input
                type="text"
                value={formData.userAgent}
                onChange={(e) => setFormData({ ...formData, userAgent: e.target.value })}
                placeholder={i18n.t('settings:sources.uaPlaceholderEx')}
              />
              <span className="hint">{i18n.t('settings:sources.uaHint')}</span>
            </div>

            <div className="form-actions">
              <button type="button" className="cancel-btn" onClick={handleCancel} disabled={isSaving}>
                {i18n.t('common:cancel')}
              </button>
              <button type="submit" className="save-btn" disabled={isSaving}>
                {isSaving ? i18n.t('common:saving') : (editingId ? i18n.t('common:saveChanges') : i18n.t('settings:sources.addSource'))}
              </button>
            </div>
          </form>
        </div>,
        document.body
      )}

      {/* Category Manager */}
      {categoryManagerSource && createPortal(
        <CategoryManager
          sourceId={categoryManagerSource.id}
          sourceName={categoryManagerSource.name}
          onClose={() => setCategoryManagerSource(null)}
          onChange={onSourcesChange}
        />,
        document.body
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && createPortal(
        <div className="source-form-overlay">
          <div className="source-form" style={{ maxWidth: '400px', height: 'auto' }}>
            <h3>{i18n.t('settings:sources.deleteSourceTitle')}</h3>
            <p style={{ color: 'var(--text-primary)', marginBottom: '24px', lineHeight: '1.5' }}>
              {i18n.t('settings:sources.deleteConfirmPre')}<strong>{i18n.t('settings:sources.confirmDeleteName', { name: deleteConfirm.name })}</strong>{i18n.t('settings:sources.deleteConfirmPost')}
              <br /><br />
              {i18n.t('settings:sources.deleteSourceWarning')}
            </p>
            <div className="form-actions" style={{ marginTop: '0' }}>
              <button
                className="cancel-btn"
                onClick={() => setDeleteConfirm(null)}
                disabled={isDeleting}
              >
                {i18n.t('common:cancel')}
              </button>
              <button
                className="save-btn"
                onClick={confirmDelete}
                disabled={isDeleting}
                style={{ borderColor: '#ff4444', color: '#ff4444', background: 'rgba(255, 68, 68, 0.1)' }}
              >
                {isDeleting ? i18n.t('common:deleting') : i18n.t('common:yesDelete')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete Backup Confirmation Modal */}
      {deleteBackupConfirm && createPortal(
        <div className="source-form-overlay" style={{ zIndex: 1002 }}>
          <div className="source-form" style={{ maxWidth: '400px', height: 'auto' }}>
            <h3>{i18n.t('settings:sources.deleteBackupTitle')}</h3>
            <p style={{ color: 'var(--text-primary)', marginBottom: '24px', lineHeight: '1.5' }}>
              {i18n.t('settings:sources.deleteBackupConfirm')}
            </p>
            <div className="form-actions" style={{ marginTop: '0' }}>
              <button
                type="button"
                className="cancel-btn"
                onClick={() => setDeleteBackupConfirm(null)}
              >
                {i18n.t('common:cancel')}
              </button>
              <button
                type="button"
                className="save-btn"
                onClick={confirmDeleteBackup}
                style={{ borderColor: '#ff4444', color: '#ff4444', background: 'rgba(255, 68, 68, 0.1)' }}
              >
                {i18n.t('common:yesDelete')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
        </>
      )}

      {activeSubTab === 'epg' && (
        <div className="settings-section">
          <div className="section-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3>{i18n.t('settings:sources.globalEpgLinks')}</h3>
              <div className="epg-tooltip">
                <span className="epg-tooltip-icon">?</span>
                <div className="epg-tooltip-content">
                  {i18n.t('settings:sources.epgTooltip')}
                </div>
              </div>
            </div>
            <div className="section-actions">
              {globalEpgLinks.length > 0 && (
                <button
                  className="sync-btn"
                  onClick={handleSyncAllEpg}
                  disabled={syncingAllEpg || syncingEpgId !== null}
                  style={{ minWidth: '100px' }}
                >
                  {syncingAllEpg ? i18n.t('common:syncing') : i18n.t('settings:sources.syncAll')}
                </button>
              )}
              <button className="add-btn" onClick={handleAddEpg}>{i18n.t('settings:sources.addEpg')}</button>
            </div>
          </div>

          {sortedEpgLinks.length === 0 ? (
            <div className="empty-state">
              <p>{i18n.t('settings:sources.noEpgLinks')}</p>
              <p className="hint">{i18n.t('settings:sources.noEpgLinksHint')}</p>
            </div>
          ) : (
            <DndContext
              sensors={epgSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleEpgDragEnd}
            >
              <SortableContext
                items={sortedEpgLinks.map((e) => e.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="epg-links-list sortable-list">
                  {sortedEpgLinks.map((epg, index) => (
                    <SortableEpgCard
                      key={epg.id}
                      epg={epg}
                      index={index}
                      isLast={index === sortedEpgLinks.length - 1}
                      sources={sources}
                      isSyncing={syncingEpgId === epg.id}
                      syncingAllEpg={syncingAllEpg}
                      formatLastSynced={formatLastSynced}
                      onMoveUp={moveEpgUp}
                      onMoveDown={moveEpgDown}
                      onSync={handleSyncEpg}
                      onViewMatches={setViewMatchesEpg}
                      onEdit={handleEditEpg}
                      onDelete={handleDeleteEpgClick}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>
      )}

      {activeSubTab === 'refresh' && (
        <DataRefreshTab
          vodRefreshHours={vodRefreshHours}
          epgRefreshHours={epgRefreshHours}
          epgSyncConcurrency={epgSyncConcurrency}
          onVodRefreshChange={onVodRefreshChange || (() => {})}
          onEpgRefreshChange={onEpgRefreshChange || (() => {})}
          onEpgSyncConcurrencyChange={onEpgSyncConcurrencyChange || (() => {})}
        />
      )}

      {activeSubTab === 'global_ua' && (
        <div className="settings-section" style={{ paddingTop: '8px' }}>
          <div className="section-header">
            <h3>{i18n.t('settings:sources.globalUserAgent')}</h3>
          </div>

          <p className="section-description" style={{ opacity: 0.8, fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1.5rem', lineHeight: '1.4' }}>
            {i18n.t('settings:sources.globalUaDesc')}
          </p>

          <div className="settings-form" style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem', maxWidth: '550px' }}>
            <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <label style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>{i18n.t('settings:sources.uaString')}</label>
              
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.2rem' }}>
                {PRESET_USER_AGENTS.map((preset) => {
                  const isActive = (globalLiveTvUserAgent || '').trim() === preset.value;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => setGlobalLiveTvUserAgent(preset.value)}
                      style={{
                        padding: '6px 14px',
                        borderRadius: '20px',
                        fontSize: '0.82rem',
                        fontWeight: isActive ? 600 : 400,
                        background: isActive ? 'var(--primary-color, #3b82f6)' : 'var(--surface-color, rgba(255, 255, 255, 0.06))',
                        color: isActive ? '#fff' : 'var(--text-primary)',
                        border: isActive ? '1px solid var(--primary-color, #3b82f6)' : '1px solid var(--surface-border, rgba(255, 255, 255, 0.15))',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {i18n.t(preset.labelKey, { defaultValue: preset.labelKey })}
                    </button>
                  );
                })}
              </div>

              <input
                type="text"
                value={globalLiveTvUserAgent || ''}
                onChange={(e) => setGlobalLiveTvUserAgent(e.target.value)}
                placeholder={i18n.t('settings:sources.uaPlaceholderEg')}
                style={{
                  padding: '10px 12px',
                  borderRadius: '6px',
                  background: 'var(--surface-color)',
                  border: '1px solid var(--surface-border)',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                  outline: 'none',
                  transition: 'border-color 0.2s ease',
                }}
              />
              <p className="form-hint" style={{ marginTop: '0.2rem', opacity: 0.7, fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                {i18n.t('settings:sources.uaFallbackHintPre')}<code>{i18n.t('settings:sources.uaFallbackHintCode')}</code>{i18n.t('settings:sources.uaFallbackHintPost')}
              </p>
            </div>
          </div>
        </div>
      )}



      {/* Add/Edit Global EPG Form */}
      {showAddEpgForm && createPortal(
        <div className="source-form-overlay">
          <form className="source-form" onSubmit={handleSubmitEpg} style={{ maxWidth: '500px' }}>
            <h3>{editingEpgId ? i18n.t('settings:sources.editGlobalEpg') : i18n.t('settings:sources.addGlobalEpg')}</h3>

            {epgFormError && <div className="form-error">{epgFormError}</div>}

            <div className="form-group">
              <label>{i18n.t('settings:sources.name')}</label>
              <input
                type="text"
                value={epgFormData.name}
                onChange={(e) => setEpgFormData({ ...epgFormData, name: e.target.value })}
                placeholder={i18n.t('settings:sources.mySharedEpg')}
              />
            </div>

            <div className="form-group">
              <label>{i18n.t('settings:sources.epgUrl')}</label>
              <input
                type="text"
                value={epgFormData.url}
                onChange={(e) => setEpgFormData({ ...epgFormData, url: e.target.value })}
                placeholder="http://example.com/epg.xml"
              />
              <span className="hint">{i18n.t('settings:sources.xmltvHint')}</span>
            </div>

            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', marginBottom: '15px' }}>
              <input
                type="checkbox"
                id="saveEntireEpg"
                checked={epgFormData.saveEntireEpg}
                onChange={(e) => setEpgFormData({ ...epgFormData, saveEntireEpg: e.target.checked })}
                style={{ cursor: 'pointer', width: '16px', height: '16px' }}
              />
              <label htmlFor="saveEntireEpg" style={{ cursor: 'pointer', marginBottom: 0, fontWeight: 'normal', fontSize: '0.85rem', color: 'var(--text-primary)', textTransform: 'none' }}>
                {i18n.t('settings:sources.cacheEntireEpg')}
              </label>
            </div>

            <div className="form-group">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <label style={{ marginBottom: 0 }}>{i18n.t('settings:sources.linkedSources')}</label>
                {sources.length > 0 && (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      style={{ padding: '4px 8px', fontSize: '12px', cursor: 'pointer', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', borderRadius: '4px', color: 'var(--text-primary)' }}
                      onClick={() => setEpgFormData({ ...epgFormData, sourceIds: sources.map(s => s.id) })}
                    >
                      {i18n.t('settings:sources.selectAll')}
                    </button>
                    <button
                      type="button"
                      style={{ padding: '4px 8px', fontSize: '12px', cursor: 'pointer', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', borderRadius: '4px', color: 'var(--text-primary)' }}
                      onClick={() => setEpgFormData({ ...epgFormData, sourceIds: [] })}
                    >
                      {i18n.t('settings:sources.selectNone')}
                    </button>
                  </div>
                )}
              </div>
              <span className="hint" style={{ display: 'block', marginBottom: '10px', marginTop: '8px' }}>
                {i18n.t('settings:sources.linkedSourcesHint')}
              </span>
              {sources.length === 0 ? (
                <p className="hint">{i18n.t('settings:sources.noSourcesAvailable')}</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {sources.map(source => (
                    <label
                      key={source.id}
                      className="checkbox-label"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 12px',
                        background: 'var(--surface-color)',
                        borderRadius: '4px',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={epgFormData.sourceIds.includes(source.id)}
                        onChange={() => toggleEpgSourceId(source.id)}
                      />
                      <span>{source.name}</span>
                      <span className="source-type" data-source-type={source.type} style={{ marginLeft: 'auto' }}>{source.type.toUpperCase()}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="form-actions">
              <button type="button" className="cancel-btn" onClick={handleCancelEpg}>
                {i18n.t('common:cancel')}
              </button>
              <button type="submit" className="save-btn">
                {editingEpgId ? i18n.t('common:saveChanges') : i18n.t('settings:sources.addEpg')}
              </button>
            </div>
          </form>
        </div>,
        document.body
      )}

      {/* Delete Global EPG Confirmation Modal */}
      {deleteEpgConfirm && createPortal(
        <div className="source-form-overlay">
          <div className="source-form" style={{ maxWidth: '400px', height: 'auto' }}>
            <h3>{i18n.t('settings:sources.deleteEpgTitle')}</h3>
            <p style={{ color: 'var(--text-primary)', marginBottom: '24px', lineHeight: '1.5' }}>
              {i18n.t('settings:sources.deleteConfirmPre')}<strong>{i18n.t('settings:sources.confirmDeleteName', { name: deleteEpgConfirm.name })}</strong>{i18n.t('settings:sources.deleteConfirmPost')}
              <br /><br />
              {i18n.t('settings:sources.deleteEpgWarning')}
            </p>
            <div className="form-actions" style={{ marginTop: '0' }}>
              <button
                className="cancel-btn"
                onClick={() => setDeleteEpgConfirm(null)}
              >
                {i18n.t('common:cancel')}
              </button>
              <button
                className="save-btn"
                onClick={confirmDeleteEpg}
                style={{ borderColor: '#ff4444', color: '#ff4444', background: 'rgba(255, 68, 68, 0.1)' }}
              >
                {i18n.t('common:yesDelete')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Global EPG Matches Modal */}
      {viewMatchesEpg && (
        <GlobalEpgMatchesModal
          epgLink={viewMatchesEpg}
          sources={sources}
          onClose={() => setViewMatchesEpg(null)}
        />
      )}
    </div>
  );
}

interface GlobalEpgMatchesModalProps {
  epgLink: GlobalEpgLink;
  sources: Source[];
  onClose: () => void;
}

function GlobalEpgMatchesModal({ epgLink, sources, onClose }: GlobalEpgMatchesModalProps) {
  useTranslation();
  const epgClockFormat = useEpgClockFormat();
  const [channels, setChannels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedChannel, setSelectedChannel] = useState<any | null>(null);
  const [programs, setPrograms] = useState<any[]>([]);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  const [activeTab, setActiveTab] = useState<'matched' | 'all'>('matched');
  const [cacheChannels, setCacheChannels] = useState<any[]>([]);
  const [cacheLoading, setCacheLoading] = useState(false);
  const [visibleCount, setVisibleCount] = useState(100);

  // Reset visibleCount on search/tab change
  useEffect(() => {
    setVisibleCount(100);
  }, [searchQuery, activeTab]);

  // 1. Fetch matched channels on mount/link change
  useEffect(() => {
    setLoading(true);
    setChannels([]);
    setSelectedChannel(null);
    setPrograms([]);

    const matchedStreamIds = epgLink.lastSyncResult?.matchedStreamIds || [];
    if (matchedStreamIds.length === 0) {
      setLoading(false);
      return;
    }

    db.channels.where('stream_id').anyOf(matchedStreamIds).toArray()
      .then((chans) => {
        // Sort alphabetically by name
        const sorted = chans.sort((a, b) => (a.name || '').localeCompare(b.name || '')) as any[];
        setChannels(sorted);
        if (activeTab === 'matched' && sorted.length > 0) {
          setSelectedChannel(sorted[0]);
        }
      })
      .catch((err: any) => {
        console.error('[GlobalEpgMatchesModal] Failed to load matched channels:', err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [epgLink]);

  // 1b. Fetch all EPG channels from cache DB on activeTab change
  useEffect(() => {
    if (activeTab !== 'all' || cacheChannels.length > 0 || !epgLink.saveEntireEpg) return;
    
    setCacheLoading(true);
    const fetchCacheChannels = async () => {
      try {
        const cacheDbName = `epg_cache_${epgLink.id}`;
        const Database = (await import('@tauri-apps/plugin-sql')).default;
        const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);
        
        const rows = await cacheDb.select(
          'SELECT id, display_name, icon_url FROM epg_channels'
        ) as any[];
        
        const mapped = rows.map(r => ({
          stream_id: r.id, // EPG channel ID
          name: r.display_name,
          stream_icon: r.icon_url || '',
          epg_channel_id: r.id,
          source_id: `global_epg_${epgLink.id}`,
          is_cache: true
        }));
        
        const sorted = mapped.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        setCacheChannels(sorted);
        if (activeTab === 'all' && sorted.length > 0) {
          setSelectedChannel(sorted[0]);
        }
      } catch (err) {
        console.error('[GlobalEpgMatchesModal] Failed to load cache channels:', err);
      } finally {
        setCacheLoading(false);
      }
    };
    fetchCacheChannels();
  }, [activeTab, epgLink]);

  // 1c. Set active channel when tab changes
  useEffect(() => {
    if (activeTab === 'matched') {
      if (channels.length > 0) {
        setSelectedChannel(channels[0]);
      } else {
        setSelectedChannel(null);
      }
    } else {
      if (cacheChannels.length > 0) {
        setSelectedChannel(cacheChannels[0]);
      } else {
        setSelectedChannel(null);
      }
    }
  }, [activeTab]);

  // 2. Fetch programs when selectedChannel changes
  useEffect(() => {
    if (!selectedChannel) {
      setPrograms([]);
      return;
    }

    setProgramsLoading(true);
    const fetchPrograms = async () => {
      try {
        if (selectedChannel.is_cache) {
          const cacheDbName = `epg_cache_${epgLink.id}`;
          const Database = (await import('@tauri-apps/plugin-sql')).default;
          const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);
          
          const progs = await cacheDb.select(
            'SELECT * FROM programs WHERE stream_id = $1 ORDER BY start ASC',
            [selectedChannel.stream_id]
          ) as any[];
          
          setPrograms(progs);
        } else {
          const dbInstance = await (db as any).dbPromise;
          const progs = await dbInstance.select(
            'SELECT * FROM programs WHERE stream_id = ? ORDER BY start ASC',
            [selectedChannel.stream_id]
          );
          const processed = progs.map((p: any) => ({
            ...p,
            description: decompressEpgDescription(p.description) ?? p.description,
          }));
          setPrograms(processed);
        }
      } catch (err: any) {
        console.error('[GlobalEpgMatchesModal] Failed to load programs:', err);
        setPrograms([]);
      } finally {
        setProgramsLoading(false);
      }
    };
    fetchPrograms();
  }, [selectedChannel]);

  // Filter channels based on search query
  const activeChannels = activeTab === 'matched' ? channels : cacheChannels;
  const filteredChannels = activeChannels.filter((ch) =>
    (ch.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (ch.epg_channel_id || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Get source name helper
  const getSourceName = (sourceId: string) => {
    return sources.find((s) => s.id === sourceId)?.name || sourceId;
  };

  // Format program times
  const formatProgramTime = (timeStr: string | Date) => {
    try {
      const d = new Date(timeStr);
      return formatTime(d, { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' });
    } catch {
      return String(timeStr);
    }
  };

  const formatProgramDate = (timeStr: string | Date) => {
    try {
      const d = new Date(timeStr);
      return formatDate(d, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  };

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 20000,
        background: 'var(--bg-overlay)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(8px)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '950px',
          height: '700px',
          background: 'var(--surface-color)',
          border: '1px solid var(--surface-border)',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid var(--surface-border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--bg-tertiary)',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-primary)', fontWeight: 600 }}>
              {epgLink.name}
            </h3>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {i18n.t('settings:sources.matchedChannels')}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              outline: 'none',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        {/* Body Split Container */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left Column - Channel List */}
          <div
            style={{
              width: '320px',
              borderRight: '1px solid var(--surface-border)',
              display: 'flex',
              flexDirection: 'column',
              padding: '16px',
              gap: '12px',
              background: 'var(--bg-tertiary)',
            }}
          >
            {epgLink.saveEntireEpg && (
              <div style={{ display: 'flex', background: 'var(--surface-color)', padding: '3px', borderRadius: '8px', border: '1px solid var(--surface-border)' }}>
                <button
                  onClick={() => setActiveTab('matched')}
                  style={{
                    flex: 1,
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: 'none',
                    fontSize: '0.8rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                    background: activeTab === 'matched' ? 'var(--surface-glow)' : 'transparent',
                    color: activeTab === 'matched' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    outline: 'none',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {i18n.t('settings:sources.matchedTab', { count: channels.length })}
                </button>
                <button
                  onClick={() => setActiveTab('all')}
                  style={{
                    flex: 1,
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: 'none',
                    fontSize: '0.8rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                    background: activeTab === 'all' ? 'var(--surface-glow)' : 'transparent',
                    color: activeTab === 'all' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    outline: 'none',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {i18n.t('settings:sources.allEpgChannels')}
                </button>
              </div>
            )}

            <input
              type="text"
              placeholder={activeTab === 'matched' ? i18n.t('settings:sources.searchMatched') : i18n.t('settings:sources.searchAllEpg')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid var(--surface-border)',
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
                outline: 'none',
              }}
            />

            <div
              onScroll={(e) => {
                const target = e.currentTarget;
                if (target.scrollHeight - target.scrollTop <= target.clientHeight + 100) {
                  setVisibleCount(prev => Math.min(prev + 100, filteredChannels.length));
                }
              }}
              style={{
                flex: 1,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
              className="sources-list"
            >
              {loading || (activeTab === 'all' && cacheLoading) ? (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                  {i18n.t('settings:sources.loadingChannels')}
                </div>
              ) : filteredChannels.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                  {activeTab === 'matched' 
                    ? (channels.length === 0 ? i18n.t('settings:sources.noChannelsMatched') : i18n.t('settings:sources.noMatchingFound'))
                    : (cacheChannels.length === 0 ? i18n.t('settings:sources.noCacheChannels') : i18n.t('settings:sources.noMatchingEpg'))}
                </div>
              ) : (
                filteredChannels.slice(0, visibleCount).map((ch) => {
                  const isSelected = selectedChannel?.stream_id === ch.stream_id;
                  return (
                    <div
                      key={ch.stream_id}
                      onClick={() => setSelectedChannel(ch)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '8px 12px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        background: isSelected ? 'var(--surface-glow)' : 'transparent',
                        border: isSelected ? '1px solid var(--accent-glow)' : '1px solid transparent',
                        transition: 'all 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) {
                          e.currentTarget.style.background = 'var(--surface-color)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) {
                          e.currentTarget.style.background = 'transparent';
                        }
                      }}
                    >
                      <div
                        style={{
                          width: '28px',
                          height: '28px',
                          borderRadius: '4px',
                          background: 'var(--surface-color)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          overflow: 'hidden',
                        }}
                      >
                        {ch.stream_icon ? (
                          <img
                            src={ch.stream_icon}
                            alt=""
                            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <span style={{ fontSize: '0.8rem' }}>📺</span>
                        )}
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            color: 'var(--text-primary)',
                            fontSize: '0.85rem',
                            fontWeight: 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {ch.name}
                        </div>
                        <div
                          style={{
                            color: 'var(--text-muted)',
                            fontSize: '0.75rem',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            marginTop: '2px',
                          }}
                        >
                          {ch.is_cache ? ch.epg_channel_id : getSourceName(ch.source_id)}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Column - Program List */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              padding: '24px',
              background: 'var(--surface-color)',
              overflowY: 'auto',
            }}
            className="sources-list"
          >
            {selectedChannel ? (
              <>
                {/* Channel Summary Info */}
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '24px', borderBottom: '1px solid var(--surface-border)', paddingBottom: '16px' }}>
                  <div
                    style={{
                      width: '48px',
                      height: '48px',
                      borderRadius: '6px',
                      background: 'var(--surface-color)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      border: '1px solid var(--surface-border)',
                    }}
                  >
                    {selectedChannel.stream_icon ? (
                      <img
                        src={selectedChannel.stream_icon}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    ) : (
                      <span style={{ fontSize: '1.2rem' }}>📺</span>
                    )}
                  </div>
                  <div>
                    <h4 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                      {selectedChannel.name}
                    </h4>
                    <div style={{ display: 'flex', gap: '12px', fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                      {selectedChannel.is_cache ? (
                        <span>{i18n.t('settings:sources.epgIdTvg')}: <strong style={{ color: 'var(--text-primary)' }}>{selectedChannel.epg_channel_id}</strong></span>
                      ) : (
                        <>
                          <span>{i18n.t('settings:sources.sourceColon')}: <strong>{getSourceName(selectedChannel.source_id)}</strong></span>
                          <span>•</span>
                          <span>{i18n.t('settings:sources.epgIdColon')}: <strong>{selectedChannel.epg_channel_id || i18n.t('common:none')}</strong></span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Programs List */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {programsLoading ? (
                    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                      {i18n.t('settings:sources.loadingPrograms')}
                    </div>
                  ) : programs.length === 0 ? (
                    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                      {i18n.t('settings:sources.noPrograms')}
                    </div>
                  ) : (
                    programs.map((prog) => {
                      const startTime = formatProgramTime(prog.start);
                      const endTime = formatProgramTime(prog.end);
                      const dateLabel = formatProgramDate(prog.start);
                      return (
                        <div
                          key={prog.id}
                          style={{
                            background: 'var(--surface-color)',
                            border: '1px solid var(--surface-border)',
                            borderRadius: '8px',
                            padding: '12px 16px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <span style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: 600 }}>
                              {prog.title}
                            </span>
                            <span style={{ color: 'var(--accent-primary, #00d4ff)', fontSize: '0.75rem', fontWeight: 500, background: 'var(--surface-glow)', padding: '2px 6px', borderRadius: '4px' }}>
                              {dateLabel} {startTime} - {endTime}
                            </span>
                          </div>
                          {prog.subtitle && (
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontStyle: 'italic' }}>
                              {prog.subtitle}
                            </span>
                          )}
                          {prog.description && (
                            <p style={{ margin: '4px 0 0 0', color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: '1.4' }}>
                              {prog.description}
                            </p>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.95rem' }}>
                {i18n.t('settings:sources.selectChannel')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
