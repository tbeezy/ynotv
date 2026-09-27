import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import './EpgEditorModal.css';
import { db, updateChannelsBatch } from '../db';
import type { StoredChannel, StoredCategory } from '../db';
import { ChannelLogo } from './ChannelLogo';
import { storedLogoPaddingOverride } from '../utils/logoPadding';
import { useEpgClockFormat } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { activeLocale } from '../utils/dateTime';


import {
  getChannelOverride,
  upsertChannelOverride,
  getEditorProgramsForStream,
  upsertProgramOverride,
  removeProgramOverride,
  restoreProgramOverride,
  searchEpgChannels,
  autoMatchChannelName,
  bestEpgMatchCandidate,
  loadEpgMatchCandidates,
  matchChannelWithCleanNames,
  getPreviewProgramsForEpgId,
  copyProgramsFromEpgChannel,
  resetChannelToDefault,
  unmatchAutomatchChannel,
  unmatchAutomatchChannels,
  releaseChannelFeedPin,
  countFeedPinsInSource,
  releaseFeedPinsInSource,
  listEpgMatches,
  listEpgMatchCategories,
  releaseFeedPinsForStreamIds,
  type EditorProgram,
  type ScoredEpgChannel,
  type EpgSearchMode,
  type EpgMatchCandidate,
  type EpgMatchRow,
} from '../services/epg-overrides';
import { effectiveMatchName } from '../utils/epgMatchName';
import { buildMissingEpgQuery, buildMissingEpgCountQuery } from '../utils/epgAutomatchFilter';
import { parseStripTags, shouldSyncStripTagsInput, prepareCleanNameIndex } from '../utils/epgChannelMatch';
import { priorOverrideSnapshot, type PriorOverrideSnapshot } from '../utils/epgAutomatchUndo';
import {
  buildMatchTree,
  flattenMatchTree,
  matchNodeKeys,
  type MatchLockFilter,
  type MatchTreeRow,
} from '../utils/epgMatchReport';
import { VirtualList } from './common/VirtualList';

// ─── Types ────────────────────────────────────────────────────────────────────

type EditorTab = 'channel' | 'programs' | 'search' | 'source' | 'automatch' | 'matches';
type SearchScope = 'source' | 'all';

/**
 * A channel the opt-in cleaned-name tier refused to match because several EPG
 * channels share its cleaned name. Kept so the user can pick one — or dismiss
 * it — from the run's results instead of losing it to a log line.
 */
interface AutomatchRefusal {
  streamId: string;
  sourceId: string;
  channelName: string;
  cleanedName: string;
  totalChoices: number;
  choices: EpgMatchCandidate[];
}

/**
 * One match the run applied, with everything needed to take it back: the id it
 * wrote (so a hand-match made afterwards is never clobbered) and the channel's
 * override row as it was before the run (so unmatching restores it instead of
 * deleting settings the user had set on a channel that merely had no EPG).
 */
interface AutomatchMatch {
  streamId: string;
  sourceId: string;
  channelName: string;
  epgChannelId: string;
  prior: PriorOverrideSnapshot;
  /** Set once undone, so a row can't be unmatch-ed twice. */
  unmatched?: boolean;
}

/** A line of the run's results. Only matched lines carry an `AutomatchMatch`. */
interface AutomatchDetail {
  text: string;
  type?: 'success' | 'warning' | 'error' | 'skipped';
  match?: AutomatchMatch;
}

type AutomatchResults = {
  matched: number;
  skipped: number;
  errors: number;
  ambiguous: number;
  cleaned: number;
  filtered: number;
  unmatched: number;
  details: AutomatchDetail[];
};

/**
 * The feed a channel may be pinned to, or `undefined` when the pin could never be
 * served.
 *
 * A global EPG link only ever fills the sources listed on the link, and a pinned
 * channel is skipped by *every* other feed — including its own source's. So
 * pinning a channel to a link that isn't attached to that channel's playlist
 * would leave it permanently blank instead of merely unmatched. In that case the
 * id is still saved (it works immediately, via the program copy) but no pin is
 * written, which is exactly the pre-pin behaviour.
 *
 * A pin to another *playlist's* feed is always kept: the post-sync alignment
 * copies from that feed's own channel rows, whatever it is attached to.
 */
function servablePin(
  feedSourceId: string | undefined,
  channelSourceId: string | undefined
): string | undefined {
  if (!feedSourceId) return undefined;
  const prefix = 'global_epg_';
  if (!feedSourceId.startsWith(prefix)) return feedSourceId;
  if (!channelSourceId) return undefined;
  const link = useSettingsStore
    .getState()
    .globalEpgLinks.find(l => l.id === feedSourceId.slice(prefix.length));
  if (!link || !link.sourceIds.includes(channelSourceId)) return undefined;
  return feedSourceId;
}

/**
 * The five fields the source list renders. The list loads exactly these columns:
 * `channels.toArray()` marshals all 29 of every channel in the source, which is
 * ~15 MB of objects on a 32k channel playlist. The full row is fetched when a row
 * is clicked, since that is what the channel tab reads.
 */
type SourceListRow = Pick<
  StoredChannel,
  'stream_id' | 'name' | 'stream_icon' | 'epg_channel_id' | 'source_id'
>;

export interface EpgEditorModalProps {
  /** If set, opens directly on a specific channel */
  channel?: StoredChannel;
  /** If set (and no channel provided), opens on the Source EPG tab */
  sourceId?: string;
  sourceName?: string;
  /**
   * Channels for the list tab, instead of every channel of `sourceId`. The guide
   * passes the category it is showing, so the editor opens on the list the user
   * is already looking at and a click opens that channel — the same view a
   * right-click → Edit EPG gives, without hunting for the channel first.
   */
  channelList?: StoredChannel[];
  /** What `channelList` is (a category name), used for the tab + filter labels. */
  channelListName?: string;
  onClose: () => void;
}

/**
 * Which of these channels already carry an EPG override (the dot in the list).
 *
 * Chunked because a category can hold tens of thousands of stream ids and SQLite
 * caps bound parameters — one query per chunk of the primary key is still an
 * indexed lookup, and it avoids pulling the whole overrides table into memory
 * the way the source-scoped join can.
 */
async function loadOverriddenStreamIds(
  dbInstance: { select: (sql: string, params?: unknown[]) => Promise<unknown> },
  streamIds: string[]
): Promise<Set<string>> {
  const ids = new Set<string>();
  const CHUNK = 400;
  for (let i = 0; i < streamIds.length; i += CHUNK) {
    const chunk = streamIds.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `$${j + 1}`).join(',');
    const rows = await dbInstance.select(
      `SELECT stream_id FROM epg_channel_overrides WHERE stream_id IN (${placeholders})`,
      chunk
    ) as { stream_id: string }[];
    for (const row of rows) ids.add(row.stream_id);
  }
  return ids;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDatetimeLocal(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function datetimeLocalToIso(value: string): string {
  if (!value) return '';
  return new Date(value).toISOString();
}

function formatShortDatetime(iso: string, epgClockFormat: '12h' | '24h'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(activeLocale(), {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: epgClockFormat !== '24h',
  });
}

function generateId(): string {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/* ── SVG Icons ── */
function EpgHeaderSvg({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
    </svg>
  );
}

function AntennaSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M4.93 4.93a10 10 0 0 1 14.14 0" />
      <path d="M7.76 7.76a6 6 0 0 1 8.48 0" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 14v8" />
    </svg>
  );
}

function ScheduleSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function SearchSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function TvSvg({ size = 14, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }}>
      <rect width="20" height="15" x="2" y="7" rx="2" ry="2" />
      <polyline points="17 2 12 7 7 2" />
    </svg>
  );
}

function RobotSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4" />
      <line x1="8" y1="16" x2="8" y2="16" />
      <line x1="16" y1="16" x2="16" y2="16" />
      <path d="M9 19h6" />
    </svg>
  );
}

function LockSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function SwapSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z" />
    </svg>
  );
}

function EditSvg({ size = 13, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }}>
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

function TrashSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function UndoSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

function ResetSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M23 4v6h-6" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function SaveSvg({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

function SparkleSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
    </svg>
  );
}

function SunSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function RulerSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <rect x="7" y="7" width="10" height="10" rx="1" ry="1" strokeDasharray="2 2" />
    </svg>
  );
}

function ImageSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}

function CheckSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CrossSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function WarningSvg({ size = 14, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function PlusSvg({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function ChevronDownSvg({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChevronUpSvg({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ChevronRightSvg({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** A single program row in the Programs tab */
function ProgramRow({
  prog,
  isCurrent = false,
  rowRef,
  onSave,
  onDelete,
  onRestore,
}: {
  prog: EditorProgram;
  isCurrent?: boolean;
  rowRef?: React.Ref<HTMLDivElement>;
  onSave: (updated: Partial<EditorProgram>) => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation('epg');
  const epgClockFormat = useEpgClockFormat();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(prog.title);
  const [subtitle, setSubtitle] = useState(prog.subtitle);
  const [desc, setDesc] = useState(prog.description);
  const [start, setStart] = useState(formatDatetimeLocal(prog.start));
  const [end, setEnd] = useState(formatDatetimeLocal(prog.end));

  // Reset edit fields when prog changes externally
  useEffect(() => {
    setTitle(prog.title);
    setSubtitle(prog.subtitle);
    setDesc(prog.description);
    setStart(formatDatetimeLocal(prog.start));
    setEnd(formatDatetimeLocal(prog.end));
    setEditing(false);
  }, [prog.id]);

  function handleSave() {
    onSave({
      title,
      subtitle: subtitle || undefined,
      description: desc || undefined,
      start: datetimeLocalToIso(start),
      end: datetimeLocalToIso(end),
    });
    setEditing(false);
  }

  return (
    <div
      ref={rowRef}
      className={`epg-program-row${isCurrent ? ' is-current' : ''}${prog.is_deleted ? ' is-deleted' : ''}${prog.is_custom ? ' is-custom' : ''}${editing ? ' editing' : ''}`}
    >
      <div className="epg-program-time">
        <div>{formatShortDatetime(prog.start, epgClockFormat)}</div>
        <div style={{ opacity: 0.6, fontSize: '0.7rem', marginTop: 2 }}>→ {formatShortDatetime(prog.end, epgClockFormat)}</div>
      </div>
      <div className="epg-program-info">
        <div className="epg-program-title">{prog.title || '(No title)'}</div>
        {prog.subtitle && (
          <div className="epg-program-subtitle" style={{ fontSize: '0.85em', opacity: 0.7, marginTop: 2 }}>{prog.subtitle}</div>
        )}
        <div className="epg-program-badges">
          {isCurrent && (
            <span className="epg-badge epg-badge-live" title={t('nowAiring', 'Currently Airing')}>
              <span className="epg-live-pulse" aria-hidden="true" />
              <span>{i18n.t('common:live')}</span>
            </span>
          )}
          {prog.has_override && !prog.is_deleted && !prog.is_custom && (
            <span className="epg-badge epg-badge-modified">{t('modified')}</span>
          )}
          {prog.is_custom && <span className="epg-badge epg-badge-custom">{t('custom')}</span>}
          {prog.is_deleted && <span className="epg-badge epg-badge-deleted">{t('deleted')}</span>}
        </div>
        {editing && (
          <div className="epg-program-edit-form">
            <div className="full-width">
              <input
                className="epg-editor-input"
                placeholder={t('titlePlaceholder')}
                value={title}
                onChange={e => setTitle(e.target.value)}
              />
            </div>
            <div className="full-width">
              <input
                className="epg-editor-input"
                placeholder={t('subtitleOptional')}
                value={subtitle}
                onChange={e => setSubtitle(e.target.value)}
              />
            </div>
            <div className="full-width">
              <textarea
                className="epg-editor-textarea"
                placeholder={t('descriptionOptional')}
                value={desc}
                rows={2}
                onChange={e => setDesc(e.target.value)}
              />
            </div>
            <div>
              <label className="epg-editor-label">{t('start')}</label>
              <input
                type="datetime-local"
                className="epg-editor-input"
                value={start}
                onChange={e => setStart(e.target.value)}
              />
            </div>
            <div>
              <label className="epg-editor-label">{t('end')}</label>
              <input
                type="datetime-local"
                className="epg-editor-input"
                value={end}
                onChange={e => setEnd(e.target.value)}
              />
            </div>
            <div className="full-width" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="epg-editor-btn epg-editor-btn-secondary" onClick={() => setEditing(false)}>{i18n.t('common:cancel')}</button>
              <button className="epg-editor-btn epg-editor-btn-primary" onClick={handleSave}>{t('saveProgram')}</button>
            </div>
          </div>
        )}
      </div>
      {!editing && (
        <div className="epg-program-actions">
          {prog.is_deleted ? (
            <button className="epg-program-action-btn restore" onClick={onRestore} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <UndoSvg size={12} />
              <span>{t('undo')}</span>
            </button>
          ) : (
            <>
              <button className="epg-program-action-btn" onClick={() => setEditing(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <EditSvg size={12} />
                <span>{i18n.t('common:edit')}</span>
              </button>
              <button className="epg-program-action-btn danger" onClick={onDelete} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <TrashSvg size={12} />
                <span>{i18n.t('common:delete')}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function EpgEditorModal({
  channel: initialChannel,
  sourceId,
  sourceName,
  channelList,
  channelListName,
  onClose,
}: EpgEditorModalProps) {
  const { t } = useTranslation('epg');
  const epgClockFormat = useEpgClockFormat();
  const overlayRef = useRef<HTMLDivElement>(null);

  // ── Navigation state ──
  // `channelList` is honoured even when empty: the caller asked for a list view,
  // and falling back to the channel tab with no channel renders a blank body.
  const [activeTab, setActiveTab] = useState<EditorTab>(
    initialChannel ? 'channel' : (sourceId || channelList) ? 'source' : 'channel'
  );
  const [channel, setChannel] = useState<StoredChannel | undefined>(initialChannel);
  const resolvedSourceId = channel?.source_id ?? sourceId;

  const epgLogoDisplay = useSettingsStore((s) => s.epgLogoDisplay);
  const sourceLogoDisplayOverrides = useSettingsStore((s) => s.sourceLogoDisplayOverrides);
  const sourceLogoBackgroundOverrides = useSettingsStore((s) => s.sourceLogoBackgroundOverrides);
  const logoDefaultBackground = useSettingsStore((s) => s.logoDefaultBackground);
  const sourceDisplayOverride = channel?.source_id ? sourceLogoDisplayOverrides?.[channel.source_id] : undefined;
  const logoShape = (sourceDisplayOverride || epgLogoDisplay) as 'square' | 'rectangle';
  // What 'Default' resolves to for THIS channel: the source-level override
  // (may force 'auto' = luminance detection) beats the global default.
  const resolvedDefaultBg: 'auto' | 'light' | 'dark' =
    channel?.source_id
      ? (sourceLogoBackgroundOverrides[channel.source_id] ?? logoDefaultBackground)
      : logoDefaultBackground;


  // ── Channel tab state ──
  const [rawChannel, setRawChannel] = useState<StoredChannel | null>(null);
  const [tvgId, setTvgId] = useState('');
  // The TVG-ID as loaded (to detect a manual id change) and the feed the user
  // pinned this channel to (`epg_channel_overrides.epg_source_id`).
  const [originalTvgId, setOriginalTvgId] = useState('');
  const [pinnedFeed, setPinnedFeed] = useState<string | undefined>(undefined);
  // 'Use my name for EPG matching' — replaces the provider name as the matching
  // key (epg_channel_overrides.match_by_alias).
  const [matchByAlias, setMatchByAlias] = useState(false);
  // The channel's own name for matching (`channels.alias`) — editable here so a
  // provider name that can't match a feed doesn't force a trip to Manage
  // Channels. Empty means "no name of my own": the provider name is used.
  const [matchNameDraft, setMatchNameDraft] = useState('');
  // Feed locks in this channel's playlist (Programs tab bulk release).
  const [pinnedInPlaylist, setPinnedInPlaylist] = useState(0);
  const [confirmReleaseAll, setConfirmReleaseAll] = useState(false);
  const [logoUrl, setLogoUrl] = useState('');
  const [logoBackground, setLogoBackground] = useState<'auto' | 'light' | 'dark'>('auto');
  /**
   * No choice (`undefined`) by default: the channel's tile then follows the global
   * Logo Tile Layout setting. `'default'` and `'none'` are the user's explicit
   * choices and are the only states that belong in the database — a channel whose
   * tile was never touched must not have one recorded on Save, or editing its
   * TVG-ID would silently pull it out of the global Full-Bleed setting.
   */
  const [logoPadding, setLogoPadding] = useState<'default' | 'none' | undefined>(undefined);
  const [epgLogoUrl, setEpgLogoUrl] = useState('');
  const [timeshiftHours, setTimeshiftHours] = useState('0');
  const [channelSaving, setChannelSaving] = useState(false);
  const [channelSaved, setChannelSaved] = useState(false);

  // ── Channel tab: which name EPG matching will use ──
  // The provider hands us one name; the channel's own name (`channels.alias`) is
  // the other. Matching uses exactly one of them (see effectiveMatchName), so
  // both are shown here and the effective one is named in the hint — an
  // un-renamed channel used to just say "rename it in Manage Channels".
  const providerName = (rawChannel?.name ?? channel?.name ?? '').trim();
  const typedMatchName = matchNameDraft.trim();
  // Typing the provider name back — or clearing the field — means "no name of my
  // own", the same rule the rename in Manage Channels uses.
  const customMatchName = typedMatchName && typedMatchName !== providerName ? typedMatchName : '';
  const effectiveName = matchByAlias && customMatchName ? customMatchName : providerName;

  // ── Programs tab state ──
  const [programs, setPrograms] = useState<EditorProgram[]>([]);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSubtitle, setNewSubtitle] = useState('');
  const [newDesc, setNewDesc]   = useState('');
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd]     = useState('');
  const currentProgramRowRef = useRef<HTMLDivElement>(null);
  const scrolledStreamIdRef = useRef<string | null>(null);

  const currentProgramId = useMemo(() => {
    const now = Date.now();
    const match = programs.find(p => {
      if (p.is_deleted) return false;
      const s = new Date(p.start).getTime();
      const e = new Date(p.end).getTime();
      return !isNaN(s) && !isNaN(e) && s <= now && now < e;
    });
    return match?.id;
  }, [programs]);

  const targetScrollProgramId = useMemo(() => {
    if (currentProgramId) return currentProgramId;
    const now = Date.now();
    const upcoming = programs.find(p => {
      if (p.is_deleted) return false;
      const s = new Date(p.start).getTime();
      return !isNaN(s) && s > now;
    });
    return upcoming?.id;
  }, [currentProgramId, programs]);

  const scrollToCurrentProgram = useCallback((smooth = true) => {
    if (currentProgramRowRef.current) {
      currentProgramRowRef.current.scrollIntoView({
        block: 'center',
        behavior: smooth ? 'smooth' : 'auto',
      });
    }
  }, []);

  // ── Search tab state ──
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<SearchScope>('source');
  const [searchMode, setSearchMode] = useState<EpgSearchMode>('m3u');
  const [searchResults, setSearchResults] = useState<ScoredEpgChannel[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [autoSearching, setAutoSearching] = useState(false);

  // ── Search preview state (click a result to see its programs) ──
  const [previewResult, setPreviewResult] = useState<ScoredEpgChannel | null>(null);
  const [previewPrograms, setPreviewPrograms] = useState<EditorProgram[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  // Load programs when preview result changes
  useEffect(() => {
    if (!previewResult) { setPreviewPrograms([]); return; }
    setPreviewLoading(true);
    getPreviewProgramsForEpgId(previewResult.id, 3, previewResult.source_id)
      .then(p => setPreviewPrograms(p.filter(prog => !prog.is_deleted)))
      .catch(() => setPreviewPrograms([]))
      .finally(() => setPreviewLoading(false));
  }, [previewResult?.id, previewResult?.source_id]);

  // ── Reset Confirm State ──
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // ── Source name map (id → friendly name) for search results ──
  const [sourceNameMap, setSourceNameMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!window.storage) return;
    window.storage.getSources().then((sourcesResult) => {
      const map = new Map<string, string>();
      if (sourcesResult.data) {
        for (const s of sourcesResult.data) map.set(s.id, s.name);
      }
      const globalEpgLinks = useSettingsStore.getState().globalEpgLinks;
      for (const link of globalEpgLinks) {
        map.set(`global_epg_${link.id}`, `${link.name} (Cache)`);
      }
      setSourceNameMap(map);
    }).catch(() => {});
  }, []);

  // ── Source tab state ──
  const [sourceChannels, setSourceChannels] = useState<SourceListRow[]>([]);
  const [sourceFilter, setSourceFilter] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  /** The list's own scroll container — the virtualizer needs it as its scroll element. */
  const sourceListRef = useRef<HTMLDivElement>(null);
  // Track which stream_ids have overrides (for the indicator dot)
  const [overriddenIds, setOverriddenIds] = useState<Set<string>>(new Set());

  // ── Matches report state ──
  const [matchRows, setMatchRows] = useState<EpgMatchRow[]>([]);
  // Starts true: the tab's first frame has no rows yet, so without this the empty
  // state would flash for a frame before the load it is waiting on even starts.
  const [matchLoading, setMatchLoading] = useState(true);
  const [matchFilter, setMatchFilter] = useState('');
  /** Which matches the tree keeps: every one, any lock, or only locks to a foreign feed. */
  const [matchLockFilter, setMatchLockFilter] = useState<MatchLockFilter>('all');
  const [matchCategories, setMatchCategories] = useState<Map<string, string[]>>(new Map());
  /**
   * Which tree nodes are open. Sources and categories share one Set of keys, so
   * "collapse all" is an empty Set and nothing can be open twice. Collapsed by
   * default: the report opens on the playlists that hold matches, not on every
   * matched channel in the library.
   */
  const [matchExpanded, setMatchExpanded] = useState<Set<string>>(() => new Set());
  /** Node whose bulk release is waiting for its second click (null = none). */
  const [matchConfirmKey, setMatchConfirmKey] = useState<string | null>(null);
  /**
   * Whether a load has ever landed. A later load then keeps what is already on
   * screen, so re-entering the tab never blanks the tree behind a spinner.
   */
  const matchLoadedRef = useRef(false);
  /**
   * Where the list is scrolled to, kept outside React because the report unmounts
   * when another tab is opened — which takes the container's own offset with it.
   */
  const matchScrollTopRef = useRef(0);
  /** The report's own scroll container — the virtualizer needs it as its scroll element. */
  const matchListRef = useRef<HTMLDivElement>(null);

  // ── Automatch tab state ──
  const [automatchSources, setAutomatchSources] = useState<{ id: string; name: string }[]>([]);
  const [automatchSourceId, setAutomatchSourceId] = useState('');
  const [automatchChannelScope, setAutomatchChannelScope] = useState<SearchScope>('source');
  const [automatchEpgScope, setAutomatchEpgScope] = useState<SearchScope>('source');
  const [automatchMode, setAutomatchMode] = useState<EpgSearchMode>('m3u');
  // 90% by default: a run writes what it matches straight to the library, and a
  // loose threshold (the old 40%) will happily fill a source with lookalike
  // channels before the user has read the results. Lowering it is a deliberate
  // choice now, rather than what happens when nobody touches the slider.
  const [automatchThreshold, setAutomatchThreshold] = useState(90);
  const [automatchCategories, setAutomatchCategories] = useState<string[]>([]);
  const [automatchAllCategories, setAutomatchAllCategories] = useState(true);
  const [automatchRunning, setAutomatchRunning] = useState(false);
  // Opt-in decorated-name handling for this tab (persisted, default off).
  const epgAutomatchCleanNames = useSettingsStore((s) => s.epgAutomatchCleanNames);
  const setEpgAutomatchCleanNames = useSettingsStore((s) => s.setEpgAutomatchCleanNames);
  const epgAutomatchStripTags = useSettingsStore((s) => s.epgAutomatchStripTags);
  const setEpgAutomatchStripTags = useSettingsStore((s) => s.setEpgAutomatchStripTags);
  // Persisted and on by default: sweep only the channels the app actually shows.
  const epgAutomatchEnabledOnly = useSettingsStore((s) => s.epgAutomatchEnabledOnly);
  const setEpgAutomatchEnabledOnly = useSettingsStore((s) => s.setEpgAutomatchEnabledOnly);
  const enabledOnly = epgAutomatchEnabledOnly !== false;
  const [stripTagsInput, setStripTagsInput] = useState(() => (epgAutomatchStripTags ?? []).join(', '));
  useEffect(() => {
    if (!shouldSyncStripTagsInput(stripTagsInput, epgAutomatchStripTags)) return;
    setStripTagsInput((epgAutomatchStripTags ?? []).join(', '));
  }, [epgAutomatchStripTags]);
  const [automatchProgress, setAutomatchProgress] = useState<{ matched: number; total: number } | null>(null);
  const [automatchResults, setAutomatchResults] = useState<AutomatchResults | null>(null);
  // Ambiguous refusals from the last run, kept as pickable rows so a refusal is a
  // to-do item rather than a dead end.
  const [automatchRefusals, setAutomatchRefusals] = useState<AutomatchRefusal[]>([]);
  const [resolvingRefusal, setResolvingRefusal] = useState<string | null>(null);
  /** Channel currently being unmatch-ed, and per-row messages after a failure or a stale match. */
  const [unmatchingId, setUnmatchingId] = useState<string | null>(null);
  const [unmatchNotices, setUnmatchNotices] = useState<Record<string, string>>({});
  /** The whole-run undo: armed (two-step confirm), in flight, or reporting a failure. */
  const [confirmUndoAll, setConfirmUndoAll] = useState(false);
  const [undoingAll, setUndoingAll] = useState(false);
  const [undoAllError, setUndoAllError] = useState<string | null>(null);
  /** Scroll container for the virtualized results list. */
  const automatchListRef = useRef<HTMLDivElement>(null);
  const [sourceCategories, setSourceCategories] = useState<StoredCategory[]>([]);
  const [automatchLogFilter, setAutomatchLogFilter] = useState<'all' | 'success' | 'warning' | 'error' | 'skipped'>('all');

  const filteredAutomatchDetails = useMemo(() => {
    if (!automatchResults) return [];
    if (automatchLogFilter === 'all') return automatchResults.details;
    return automatchResults.details.filter(d => {
      if (automatchLogFilter === 'success') return d.type === 'success' || d.text.startsWith('✓');
      if (automatchLogFilter === 'warning') return d.type === 'warning' || d.text.startsWith('⚠');
      if (automatchLogFilter === 'error') return d.type === 'error' || d.text.startsWith('✗');
      if (automatchLogFilter === 'skipped') return d.type === 'skipped';
      return true;
    });
  }, [automatchResults, automatchLogFilter]);


  // ── Load channel override and raw channel when channel changes ──
  useEffect(() => {
    if (!channel) {
      setRawChannel(null);
      return;
    }

    let active = true;
    Promise.all([
      db.channels.get(channel.stream_id),
      getChannelOverride(channel.stream_id)
    ]).then(([rc, ov]) => {
      if (!active) return;
      
      const rawChan = rc || null;
      setRawChannel(rawChan);
      const loadedTvgId = ov?.epg_channel_id ?? channel.epg_channel_id ?? '';
      setTvgId(loadedTvgId);
      setOriginalTvgId(loadedTvgId);
      setPinnedFeed(ov?.epg_source_id || undefined);
      setMatchByAlias(Boolean(ov?.match_by_alias));
      setMatchNameDraft((rawChan?.alias ?? '').trim());
      
      const playlistIcon = rawChan?.stream_icon ?? channel.stream_icon ?? '';
      setLogoUrl(ov?.stream_icon ?? playlistIcon);
      setLogoBackground((ov?.logo_background as 'auto' | 'light' | 'dark') ?? 'auto');
      setLogoPadding(storedLogoPaddingOverride(ov?.logo_padding));
      
      setTimeshiftHours(ov?.timeshift_hours != null ? String(ov.timeshift_hours) : '0');
    }).catch(err => {
      console.error('[EPG Editor] Failed to load channel details:', err);
    });

    // Feed locks elsewhere in this playlist (Programs tab shows them and can
    // release them in bulk).
    setConfirmReleaseAll(false);
    countFeedPinsInSource(channel.source_id).then(count => {
      if (!active) return;
      setPinnedInPlaylist(count);
    }).catch(() => {});

    return () => { active = false; };
  }, [channel]);

  // ── Load matched EPG channel logo when tvgId changes ──
  useEffect(() => {
    if (!tvgId.trim()) {
      setEpgLogoUrl('');
      return;
    }
    db.epgChannels.get(tvgId).then(async epgChan => {
      if (epgChan?.icon_url) {
        setEpgLogoUrl(epgChan.icon_url);
        return;
      }

      // Check cache databases
      if (window.storage) {
        try {
          const globalEpgLinks = useSettingsStore.getState().globalEpgLinks;
          const cacheLinks = globalEpgLinks.filter(link => link.saveEntireEpg);
          const Database = (await import('@tauri-apps/plugin-sql')).default;
          
          for (const link of cacheLinks) {
            try {
              const cacheDbName = `epg_cache_${link.id}`;
              const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);
              const rows = await cacheDb.select(
                'SELECT icon_url FROM epg_channels WHERE id = $1 LIMIT 1',
                [tvgId]
              ) as { icon_url: string }[];
              if (rows.length > 0 && rows[0].icon_url) {
                setEpgLogoUrl(rows[0].icon_url);
                return;
              }
            } catch {
              // Ignore
            }
          }
        } catch {
          // Ignore
        }
      }

      setEpgLogoUrl('');
    }).catch(err => {
      console.warn('[EPG Editor] Failed to load matched EPG channel details:', err);
      setEpgLogoUrl('');
    });
  }, [tvgId]);

  // ── Load programs when switching to Programs tab ──
  useEffect(() => {
    if (activeTab !== 'programs' || !channel) return;
    setProgramsLoading(true);
    getEditorProgramsForStream(channel.stream_id).then(p => {
      setPrograms(p);
      setProgramsLoading(false);
    });
  }, [activeTab, channel]);

  // Reset scroll tracker when navigating away from programs tab
  useEffect(() => {
    if (activeTab !== 'programs') {
      scrolledStreamIdRef.current = null;
    }
  }, [activeTab]);

  // Auto-scroll to currently airing (or next upcoming) program when programs load
  useEffect(() => {
    if (activeTab !== 'programs' || programsLoading || programs.length === 0 || !channel) return;
    if (scrolledStreamIdRef.current === channel.stream_id) return;
    scrolledStreamIdRef.current = channel.stream_id;

    const timer = setTimeout(() => {
      scrollToCurrentProgram(false);
    }, 60);
    return () => clearTimeout(timer);
  }, [activeTab, programsLoading, programs.length, channel, scrollToCurrentProgram]);

  // ── Load source channels when switching to Source tab ──
  useEffect(() => {
    if (activeTab !== 'source') return;
    // No list tab on a single-channel modal, so never build the source-wide list
    // it would have shown.
    if (channel && !channelList) return;

    // A caller that supplies its own list (the guide's current category) already
    // decided which channels to show, so no source query is needed — and it may
    // span sources or be a category of one.
    if (channelList) {
      setSourceLoading(true);
      const sorted = [...channelList].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setSourceChannels(sorted);
      (db as any).dbPromise
        .then((dbInstance: any) => loadOverriddenStreamIds(dbInstance, sorted.map(ch => ch.stream_id)))
        .then((ids: Set<string>) => setOverriddenIds(ids))
        .catch(() => setOverriddenIds(new Set()))
        .finally(() => setSourceLoading(false));
      return;
    }

    if (!resolvedSourceId) return;
    setSourceLoading(true);
    // Only the columns the rows render, rather than every channel object Dexie
    // would materialize (29 columns each) for a list that shows five fields.
    (db as any).dbPromise
      .then((dbInstance: any) => dbInstance.select(
        `SELECT stream_id, name, stream_icon, epg_channel_id, source_id
           FROM channels
          WHERE source_id = $1`,
        [resolvedSourceId]
      ))
      .then(async (rows: SourceListRow[]) => {
        const sorted = [...rows].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        setSourceChannels(sorted);
        // Load overridden stream ids for dot indicators — source-scoped indexed join
        // instead of pulling the entire overrides table into memory.
        const dbInstance = await (db as any).dbPromise;
        const overrideRows = await dbInstance.select(
          `SELECT o.stream_id FROM epg_channel_overrides o JOIN channels c ON c.stream_id = o.stream_id WHERE c.source_id = $1`,
          [resolvedSourceId]
        ) as { stream_id: string }[];
        const ids = new Set(overrideRows.map(r => r.stream_id));
        setOverriddenIds(ids);
        setSourceLoading(false);
      })
      .catch(() => {
        // Previously an error here left the tab on "Loading channels…" for good.
        setSourceChannels([]);
        setSourceLoading(false);
      });
  }, [activeTab, resolvedSourceId, channelList]);

  // Virtual rows are positioned from the scroll offset, so a filter (or a new
  // source) that shrinks the list under the current offset would otherwise leave a
  // blank area until the next scroll event.
  useEffect(() => {
    if (sourceListRef.current) sourceListRef.current.scrollTop = 0;
  }, [sourceFilter, resolvedSourceId]);

  // ── Load the Matches report ──
  //
  // A read-only snapshot of every EPG match in the library, taken when the tab
  // opens. It is loaded whole rather than paged: the report is a browse surface,
  // the payload is a few columns per override, and grouping and filtering then
  // happen in memory, so narrowing the tree never waits on a query. A release is
  // applied to the rows in place, so it needs no reload of its own.
  useEffect(() => {
    if (activeTab !== 'matches') return;
    let cancelled = false;
    // Only a load that has nothing to show raises the loading state: a reload —
    // re-entering the tab — keeps the tree, the open nodes and the scroll offset
    // the user left, instead of blanking them for the length of the query.
    if (!matchLoadedRef.current) setMatchLoading(true);
    listEpgMatches()
      .then(rows => {
        if (cancelled) return;
        matchLoadedRef.current = true;
        setMatchRows(rows);
        setMatchLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.warn('[EPG] Failed to load the matches report:', err);
        // Keep whatever is on screen — the empty state covers the first load.
        setMatchLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeTab]);

  // Category names come from a second join over every channel→category
  // membership, so they load once, in parallel with the matches themselves, and
  // the category level shows "No category" until they arrive.
  useEffect(() => {
    if (activeTab !== 'matches' || matchCategories.size > 0) return;
    let cancelled = false;
    listEpgMatchCategories()
      .then(map => { if (!cancelled) setMatchCategories(map); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeTab, matchCategories.size]);

  // A narrowed tree starts at the top: virtual rows are positioned from the
  // scroll offset, so a filter that shortens the list under the current offset
  // would otherwise leave a blank area until the next scroll event. Deliberately
  // not keyed to the tab: returning to the tab restores the offset instead.
  useEffect(() => {
    if (activeTab !== 'matches') return;
    matchScrollTopRef.current = 0;
    if (matchListRef.current) matchListRef.current.scrollTop = 0;
  }, [matchFilter, matchLockFilter]);

  // ── Load sources for Automatch tab ──
  useEffect(() => {
    if (activeTab !== 'automatch') return;
    if (!window.storage) return;
    window.storage.getSources().then((result: any) => {
      if (result.data) {
        const sources = (result.data as any[])
          .filter((s: any) => s.enabled !== false)
          .map((s: any) => ({ id: s.id, name: s.name }));
        setAutomatchSources(sources);
        if (resolvedSourceId && sources.some((s: any) => s.id === resolvedSourceId)) {
          if (!automatchSourceId || !sources.some((s: any) => s.id === automatchSourceId)) {
            setAutomatchSourceId(resolvedSourceId);
          }
        } else if ((!automatchSourceId || !sources.some((s: any) => s.id === automatchSourceId)) && sources.length > 0) {
          setAutomatchSourceId(sources[0].id);
        }
      }
    }).catch(() => {});
  }, [activeTab, resolvedSourceId]);

  // ── Load categories for Automatch tab ──
  useEffect(() => {
    if (activeTab !== 'automatch') return;
    if (!automatchSourceId || automatchChannelScope !== 'source') {
      setSourceCategories([]);
      return;
    }
    db.categories.where('source_id').equals(automatchSourceId).toArray().then(cats => {
      const sorted = cats.sort((a, b) => (a.category_name || '').localeCompare(b.category_name || ''));
      setSourceCategories(sorted);
    });
  }, [activeTab, automatchSourceId, automatchChannelScope]);

  // ── Debounced search ──
  useEffect(() => {
    if (activeTab !== 'search') return;
    if (!searchQuery.trim()) { setSearchResults([]); return; }

    const tid = setTimeout(async () => {
      setSearchLoading(true);
      const results = await searchEpgChannels(
        searchQuery,
        searchScope === 'source' ? resolvedSourceId : undefined,
        50,
        searchMode
      );
      setSearchResults(results);
      setSearchLoading(false);
    }, 300);

    return () => clearTimeout(tid);
  }, [searchQuery, searchScope, searchMode, activeTab, resolvedSourceId]);

  // ── Close on Escape ──
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (showResetConfirm) {
          setShowResetConfirm(false);
          return;
        }
        onClose();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, showResetConfirm]);

  /**
   * Edit the channel's own name. A name typed here is meant to *match*, so
   * matching switches to it — a rename that matching ignores is the exact trap
   * this field exists to close. The toggle below puts matching back on the
   * provider name without discarding the name.
   */
  function handleMatchNameChange(value: string) {
    setMatchNameDraft(value);
    const trimmed = value.trim();
    setMatchByAlias(Boolean(trimmed) && trimmed !== providerName);
  }

  /** Back to the provider's name: drops both the rename and the matching flag. */
  function handleResetMatchName() {
    setMatchNameDraft('');
    setMatchByAlias(false);
  }

  // ── Channel tab: save ──
  async function handleSaveChannel() {
    if (!channel) return;
    setChannelSaving(true);
    try {
      const hours = parseFloat(timeshiftHours);
      // The channel's own name lives on the channels row, not the override, so a
      // rename here is written directly — through the same batch helper the
      // rename in Manage Channels uses, where `null` clears the override (a
      // plain update() drops `undefined` and would silently do nothing).
      const nextAlias = customMatchName || null;
      if ((rawChannel?.alias ?? null) !== nextAlias) {
        await updateChannelsBatch([{ streamId: channel.stream_id, alias: nextAlias }]);
        setRawChannel(prev => prev ? { ...prev, alias: nextAlias ?? undefined } : prev);
      }
      // Editing the TVG-ID by hand means the pinned feed may not be the one that
      // provides the new id any more, so the pin is dropped. Saving other fields
      // (logo, timeshift) keeps it. `put` is INSERT OR REPLACE, so the pin must
      // always be written explicitly or it would be erased either way.
      const idChanged = tvgId.trim() !== originalTvgId.trim();
      await upsertChannelOverride({
        stream_id: channel.stream_id,
        epg_channel_id: tvgId.trim() || undefined,
        stream_icon: logoUrl.trim() || undefined,
        logo_background: logoBackground === 'auto' ? undefined : logoBackground,
        // Only what the user chose in this editor goes in. `undefined` means "no
        // choice", and the write path clears the stored value for it rather than
        // recording a padding — so saving a TVG-ID or a timeshift leaves a channel
        // that follows the global Tile Layout setting following it.
        logo_padding: logoPadding,
        timeshift_hours: isNaN(hours) ? 0 : hours,
        epg_source_id: idChanged ? undefined : pinnedFeed,
        match_by_alias: matchByAlias,
      });
      if (idChanged) setPinnedFeed(undefined);
      setChannelSaved(true);
      setTimeout(() => setChannelSaved(false), 2500);
    } finally {
      setChannelSaving(false);
    }
  }

  // ── Programs tab: handlers ──
  async function handleProgramSave(prog: EditorProgram, changes: Partial<EditorProgram>) {
    await upsertProgramOverride({
      id: prog.id,
      stream_id: prog.stream_id,
      title: changes.title ?? prog.title,
      subtitle: changes.subtitle ?? prog.subtitle,
      description: changes.description ?? prog.description,
      start: changes.start ?? prog.start,
      end: changes.end ?? prog.end,
      is_deleted: 0,
      is_custom: prog.is_custom ? 1 : 0,
    });
    setPrograms(prev => prev.map(p =>
      p.id === prog.id
        ? { ...p, ...changes, has_override: true }
        : p
    ));
  }

  async function handleProgramDelete(prog: EditorProgram) {
    if (prog.is_custom) {
      // Hard-remove custom programs (no tombstone needed)
      await removeProgramOverride(prog.id);
      setPrograms(prev => prev.filter(p => p.id !== prog.id));
    } else {
      // Tombstone synced programs
      await upsertProgramOverride({
        id: prog.id,
        stream_id: prog.stream_id,
        title: prog.title,
        description: prog.description,
        start: prog.start,
        end: prog.end,
        is_deleted: 1,
        is_custom: 0,
      });
      setPrograms(prev => prev.map(p =>
        p.id === prog.id ? { ...p, is_deleted: true, has_override: true } : p
      ));
    }
  }

  async function handleProgramRestore(prog: EditorProgram) {
    await restoreProgramOverride(prog.id);
    setPrograms(prev => prev.map(p =>
      p.id === prog.id ? { ...p, is_deleted: false } : p
    ));
  }

  async function handleAddCustomProgram() {
    if (!channel || !newTitle.trim() || !newStart || !newEnd) return;
    const id = generateId();
    const startIso = datetimeLocalToIso(newStart);
    const endIso = datetimeLocalToIso(newEnd);
    await upsertProgramOverride({
      id,
      stream_id: channel.stream_id,
      title: newTitle.trim(),
      subtitle: newSubtitle.trim(),
      description: newDesc.trim(),
      start: startIso,
      end: endIso,
      is_deleted: 0,
      is_custom: 1,
    });
    const newProg: EditorProgram = {
      id, stream_id: channel.stream_id,
      title: newTitle.trim(), subtitle: newSubtitle.trim(), description: newDesc.trim(),
      start: startIso, end: endIso,
      source_id: '', has_override: true,
      is_deleted: false, is_custom: true,
    };
    setPrograms(prev => [...prev, newProg].sort((a, b) => a.start.localeCompare(b.start)));
    setNewTitle(''); setNewSubtitle(''); setNewDesc(''); setNewStart(''); setNewEnd('');
    setShowAddForm(false);
  }

  // ── Search tab: auto-suggest ──
  // Searches with the SAME name the sync matches on (see effectiveMatchName),
  // taken from the Channel tab's field — so a name you are still deciding on can
  // be tried against the feeds before you save it, and once saved the suggestion
  // and the next sync cannot disagree.
  const handleAutoSuggest = useCallback(async () => {
    if (!channel) return;
    setAutoSearching(true);
    const results = await autoMatchChannelName(
      effectiveName,
      searchScope === 'source' ? resolvedSourceId : undefined,
      10,
      searchMode
    );
    setSearchResults(results);
    if (results.length > 0) setSearchQuery(results[0].display_name);
    setAutoSearching(false);
  }, [channel, effectiveName, searchScope, searchMode, resolvedSourceId]);

  // ── Search tab: apply match ──
  async function handleApplyMatch(epgChan: ScoredEpgChannel) {
    if (!channel) return;
    setApplyingId(epgChan.id);
    try {
      const current = await getChannelOverride(channel.stream_id);
      const pin = servablePin(epgChan.source_id, channel.source_id);
      await upsertChannelOverride({
        stream_id: channel.stream_id,
        epg_channel_id: epgChan.id,
        stream_icon: epgChan.icon_url || current?.stream_icon || channel.stream_icon,
        timeshift_hours: current?.timeshift_hours ?? 0,
        // Pin the channel to the feed the user picked. Ids are shared between
        // feeds, so without this a higher-priority global EPG could refill the
        // channel from a different feed than the one chosen here.
        epg_source_id: pin,
        // Kept as-is: an explicit id wins over the name, so the flag is inert
        // here, but silently dropping the user's setting would be surprising.
        match_by_alias: current?.match_by_alias,
      });
      setTvgId(epgChan.id);
      setOriginalTvgId(epgChan.id);
      setPinnedFeed(pin);
      if (epgChan.icon_url) setLogoUrl(epgChan.icon_url);
      setChannelSaved(true);
      setTimeout(() => setChannelSaved(false), 2500);

      // Immediately copy programs from the matched EPG channel so the
      // user sees programs right away without waiting for a full sync.
      try {
        await copyProgramsFromEpgChannel(channel.stream_id, epgChan.id, epgChan.source_id);
      } catch (e) {
        console.warn('[EPG Editor] Could not copy programs immediately:', e);
      }

      setActiveTab('channel');
    } finally {
      setApplyingId(null);
    }
  }

  // ── Navigate to a channel ──
  /**
   * Open a channel in the channel tab from an id alone. Both the source list and
   * the Matches report carry a column subset, so the full row the channel tab
   * reads (alias, logo, timeshift, catch-up flags) is fetched here by primary key.
   */
  async function openChannelById(streamId: string) {
    const full = await db.channels.get(streamId).catch(() => undefined);
    if (!full) return;
    setChannel(full);
    setActiveTab('channel');
  }

  // ── Source tab: navigate to channel ──
  async function handleOpenSourceChannel(row: SourceListRow) {
    await openChannelById(row.stream_id);
  }

  // ── Channel tab: reset to default ──
  function handleResetToDefault() {
    if (!channel) return;
    setShowResetConfirm(true);
  }

  async function executeResetToDefault() {
    if (!channel) return;
    await resetChannelToDefault(channel.stream_id);
    setShowResetConfirm(false);
    onClose(); // Close the modal since the channel is now reset
  }

  // ── Automatch tab: get channels missing EPG ──
  async function getChannelsMissingEpg(
    sourceId: string | undefined,
    categoryIds: string[],
    scope: SearchScope,
    enabledOnly: boolean
  ): Promise<{ channels: StoredChannel[]; hidden: number }> {
    const dbInstance = await (db as any).dbPromise;

    // `match_by_alias` comes along so the matcher looks the channel up under the
    // same name the sync will use.
    const query = buildMissingEpgQuery({
      scope,
      sourceId,
      categoryIds,
      visibility: enabledOnly ? 'visible' : 'all',
    });
    const rows = await dbInstance.select(query.sql, query.params) as any[];
    const channels = rows.map(r => ({
      ...r,
      category_ids: r.category_ids ? JSON.parse(r.category_ids) : [],
    }));

    // Count what the visible-only scope left out, so the run can say "skipped
    // 12,480 hidden channels" instead of silently doing less work than before.
    let hidden = 0;
    if (enabledOnly) {
      const countQuery = buildMissingEpgCountQuery({
        scope,
        sourceId,
        categoryIds,
        visibility: 'hidden',
      });
      const countRows = await dbInstance.select(countQuery.sql, countQuery.params) as Array<{ cnt: number }>;
      hidden = countRows[0]?.cnt ?? 0;
    }

    return { channels, hidden };
  }

  // ── Automatch tab: run auto-match for all missing channels ──
  async function handleAutoMatchMissing() {
    setAutomatchRunning(true);
    setAutomatchResults(null);
    setAutomatchProgress(null);

    try {
      const { channels, hidden: hiddenChannels } = await getChannelsMissingEpg(
        automatchChannelScope === 'source' ? automatchSourceId : undefined,
        automatchChannelScope === 'source' && !automatchAllCategories ? automatchCategories : [],
        automatchChannelScope,
        enabledOnly
      );

      if (channels.length === 0) {
        const lines = hiddenChannels > 0
          ? [t('noChannelsMissing'), t('enabledOnlySkipped', { count: hiddenChannels })]
          : [t('noChannelsMissing')];
        setAutomatchResults({
          matched: 0, skipped: 0, errors: 0, ambiguous: 0, cleaned: 0, filtered: hiddenChannels, unmatched: 0,
          details: lines.map(text => ({ text })),
        });
        setAutomatchRunning(false);
        return;
      }

      setAutomatchProgress({ matched: 0, total: channels.length });
      setAutomatchRefusals([]);
      setUnmatchNotices({});
      // A fresh run replaces the previous results, so an armed Undo all from the
      // last one has nothing left to act on.
      setConfirmUndoAll(false);
      setUndoAllError(null);

      let matched = 0;
      let skipped = 0;
      let errors = 0;
      let ambiguous = 0;
      let cleaned = 0;
      const details: AutomatchDetail[] = [];
      const refusals: AutomatchRefusal[] = [];
      const threshold = automatchThreshold / 100;
      const scopeId = automatchEpgScope === 'source' ? (automatchSourceId || undefined) : undefined;

      // The candidate list is loaded ONCE for the whole run. It does not depend
      // on the channel being matched, and the run only ever writes overrides and
      // programmes (never `channels` / `epg_channels`), so a preloaded list is
      // identical to what a per-channel query would return — while a query per
      // channel is a full candidate load (plus every global-EPG cache read) for
      // every channel in scope.
      const candidates = await loadEpgMatchCandidates(scopeId, automatchMode);
      // The opt-in cleaned-name run resolves every channel against the same
      // list, indexed once — the index is what keeps a large feed's run from
      // taking minutes.
      const cleanIndex = epgAutomatchCleanNames
        ? prepareCleanNameIndex(candidates, epgAutomatchStripTags)
        : null;

      for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        try {
          const matchName = effectiveMatchName(
            { name: ch.name, alias: (ch as any).alias },
            Boolean((ch as any).match_by_alias)
          );
          // Decorated-name handling (opt-in): strip region markers and quality
          // tags from both sides. A cleaned name shared by several EPG channels
          // is reported instead of guessed at, so the user sees exactly which
          // channels this run refused to touch.
          const cleanedMatch = cleanIndex
            ? matchChannelWithCleanNames(
                matchName,
                cleanIndex,
                threshold,
                epgAutomatchStripTags,
                // M3U mode lists the playlist's own channels, so the channel
                // itself is always a candidate — and matching it to itself
                // resolves nothing.
                ch.stream_id,
              )
            : null;

          if (cleanedMatch?.ambiguous) {
            ambiguous++;
            refusals.push({
              streamId: ch.stream_id,
              sourceId: ch.source_id,
              channelName: ch.name,
              cleanedName: cleanedMatch.cleanedName,
              totalChoices: cleanedMatch.totalChoices,
              choices: cleanedMatch.choices,
            });
            details.push({
              type: 'warning',
              text: `${ch.name} — ${t('automatchAmbiguous', {
                name: cleanedMatch.cleanedName,
                count: cleanedMatch.totalChoices,
              })}`
            });
            setAutomatchProgress({ matched: matched + skipped + errors + ambiguous, total: channels.length });
            if (i % 3 === 0) await new Promise(r => setTimeout(r, 1));
            continue;
          }

          // With cleaning on, the cleaned names ARE the comparison — falling back
          // to the raw scorer would re-introduce the tags we just removed.
          // Otherwise the channel is scored against the preloaded list, keeping
          // only the winner (nothing here needs the full ranked list).
          const bestMatch = epgAutomatchCleanNames
            ? null
            : bestEpgMatchCandidate(matchName, candidates);
          const topMatch = cleanedMatch?.match ?? (bestMatch && bestMatch.score >= threshold ? bestMatch : null);

          if (topMatch) {
            if (cleanedMatch?.match) cleaned++;
            // The row as it stood before this write, so Unmatch can restore it.
            const prior = priorOverrideSnapshot(ch as unknown as Record<string, unknown>);
            // Bulk auto-match picks a *new* id, so the old pin is replaced — but
            // only an *external* feed needs one. A candidate from the channel's own
            // source is filled by that source's own pass anyway, and pinning it to
            // itself would just put it in the always-refresh set and show up as a
            // lock in the Matches report, so native matches stay unpinned.
            const feedPin = topMatch.source_id && topMatch.source_id !== ch.source_id
              ? servablePin(topMatch.source_id, ch.source_id)
              : undefined;
            await upsertChannelOverride({
              stream_id: ch.stream_id,
              epg_channel_id: topMatch.id,
              stream_icon: topMatch.icon_url || ch.stream_icon,
              timeshift_hours: 0,
              epg_source_id: feedPin,
              match_by_alias: Boolean((ch as any).match_by_alias),
            });

            try {
              // Pass the feed so a cached global-EPG match copies from its
              // cache DB; for a plain source feed the argument is ignored and
              // the channels-table lookup is used, exactly as before.
              await copyProgramsFromEpgChannel(ch.stream_id, topMatch.id, topMatch.source_id);
            } catch (e) {
              // Non-critical
            }

            matched++;
            details.push({
              type: 'success',
              text: `${ch.name} → ${topMatch.display_name} (${(topMatch.score * 100).toFixed(0)}%)${cleanedMatch?.match ? ` · ${t('automatchViaCleaned')}` : ''}`,
              match: {
                streamId: ch.stream_id,
                sourceId: ch.source_id,
                channelName: ch.name,
                epgChannelId: topMatch.id,
                prior,
              },
            });
          } else {
            skipped++;
            if (cleanedMatch) {
              details.push({
                type: 'skipped',
                text: `${ch.name} — ${t('automatchCleanNoMatch', {
                  name: cleanedMatch.cleanedName,
                  threshold: automatchThreshold,
                })}`
              });
            } else {
              const bestScore = bestMatch?.score ?? 0;
              details.push({
                type: 'skipped',
                text: `${ch.name} — best match ${(bestScore * 100).toFixed(0)}% (below ${automatchThreshold}%)`
              });
            }
          }
        } catch (e) {
          errors++;
          details.push({ type: 'error', text: `${ch.name} — error` });
        }

        setAutomatchProgress({ matched: matched + skipped + errors + ambiguous, total: channels.length });

        // Yield to UI thread occasionally
        if (i % 3 === 0) {
          await new Promise(r => setTimeout(r, 1));
        }
      }

      setAutomatchResults({ matched, skipped, errors, ambiguous, cleaned, filtered: hiddenChannels, unmatched: 0, details });
      setAutomatchRefusals(refusals);
    } finally {
      setAutomatchRunning(false);
    }
  }

  /**
   * Resolve one refused channel from the ambiguity worklist. The user picked the
   * EPG channel that should supply its guide, so this applies exactly what the
   * run would have applied had it been confident — id, feed pin, icon and an
   * immediate program copy — and then drops the row.
   */
  async function handleResolveRefusal(refusal: AutomatchRefusal, choice: EpgMatchCandidate) {
    setResolvingRefusal(refusal.streamId);
    try {
      const current = await getChannelOverride(refusal.streamId);
      const pin = servablePin(choice.source_id, refusal.sourceId);
      await upsertChannelOverride({
        stream_id: refusal.streamId,
        epg_channel_id: choice.id,
        stream_icon: choice.icon_url || current?.stream_icon,
        timeshift_hours: current?.timeshift_hours ?? 0,
        // Same reasoning as an explicit Apply: the id alone is ambiguous across
        // feeds, so the feed the user picked is pinned to the channel.
        epg_source_id: pin,
        match_by_alias: current?.match_by_alias,
      });

      try {
        await copyProgramsFromEpgChannel(refusal.streamId, choice.id, choice.source_id);
      } catch (e) {
        console.warn('[EPG Editor] Could not copy programs immediately:', e);
      }

      setAutomatchRefusals(prev => prev.filter(r => r.streamId !== refusal.streamId));

      // If the row is the channel the modal has open, reflect the choice in the
      // Channel tab instead of leaving stale fields behind.
      if (channel && channel.stream_id === refusal.streamId) {
        setTvgId(choice.id);
        setOriginalTvgId(choice.id);
        setPinnedFeed(pin);
        if (choice.icon_url) setLogoUrl(choice.icon_url);
        setChannelSaved(true);
        setTimeout(() => setChannelSaved(false), 2500);
      }
    } catch (e) {
      console.error('[EPG Editor] Could not apply the chosen match:', e);
    } finally {
      setResolvingRefusal(null);
    }
  }

  /** Drop a refusal without matching it — the user will come back to it later. */
  function dismissRefusal(streamId: string) {
    setAutomatchRefusals(prev => prev.filter(r => r.streamId !== streamId));
  }

  /**
   * If the Channel tab has this stream open, its id, feed and icon are the ones the
   * match wrote, so they have to go back to the pre-run values with it.
   */
  function restoreChannelTabFromPrior(streamId: string, prior: PriorOverrideSnapshot) {
    if (!channel || channel.stream_id !== streamId) return;
    setTvgId('');
    setOriginalTvgId('');
    setPinnedFeed(prior.feedSourceId ?? undefined);
    setLogoUrl(prior.streamIcon ?? rawChannel?.stream_icon ?? channel.stream_icon ?? '');
    setLogoBackground((prior.logoBackground as 'auto' | 'light' | 'dark') ?? 'auto');
    setLogoPadding(storedLogoPaddingOverride(prior.logoPadding));
    setTimeshiftHours(String(prior.timeshiftHours ?? 0));
    setMatchByAlias(Boolean(prior.matchByAlias));
  }

  /**
   * Undo one match from the last run, straight from its results list.
   *
   * The run's snapshot is restored rather than the row simply being deleted, so a
   * logo background, padding or timeshift set on that channel earlier is not lost,
   * and the feed's copied guide is dropped so the rejected match stops showing.
   */
  async function handleUnmatchMatch(match: AutomatchMatch) {
    if (unmatchingId) return;
    setUnmatchingId(match.streamId);
    setUnmatchNotices(prev => {
      const next = { ...prev };
      delete next[match.streamId];
      return next;
    });

    try {
      const outcome = await unmatchAutomatchChannel(match.streamId, match.epgChannelId, match.prior);

      if (outcome === 'modified') {
        // Matched by hand after the run — that choice is newer than this row.
        setUnmatchNotices(prev => ({ ...prev, [match.streamId]: t('automatchUnmatchStale') }));
        return;
      }

      // `missing` means the row was already gone, which for the user is the same
      // outcome as a successful unmatch — so the row is retired either way.
      setAutomatchResults(prev => prev ? {
        ...prev,
        matched: Math.max(0, prev.matched - 1),
        unmatched: prev.unmatched + 1,
        details: prev.details.map(d => d.match?.streamId === match.streamId
          ? { ...d, match: { ...d.match, unmatched: true } }
          : d),
      } : prev);

      restoreChannelTabFromPrior(match.streamId, match.prior);
    } catch (e) {
      console.error('[EPG Editor] Could not unmatch channel:', e);
      setUnmatchNotices(prev => ({ ...prev, [match.streamId]: t('automatchUnmatchFailed') }));
    } finally {
      setUnmatchingId(null);
    }
  }

  /**
   * Undo every match of the last run in one pass.
   *
   * Same outcome per channel as the row-level Unmatch — newer hand-matches are left
   * alone — but the work is batched in the service so a run of thousands only
   * refreshes the library once.
   */
  async function handleUndoAllMatches() {
    if (undoingAll || !automatchResults) return;

    const targets = automatchResults.details
      .map(d => d.match)
      .filter((m): m is AutomatchMatch => m !== undefined && !m.unmatched);
    if (targets.length === 0) {
      setConfirmUndoAll(false);
      return;
    }

    setUndoingAll(true);
    setUndoAllError(null);
    try {
      const { undoneStreamIds, modifiedStreamIds } = await unmatchAutomatchChannels(
        targets.map(m => ({ streamId: m.streamId, epgChannelId: m.epgChannelId, prior: m.prior }))
      );
      const undone = new Set(undoneStreamIds);

      setAutomatchResults(prev => prev ? {
        ...prev,
        matched: Math.max(0, prev.matched - undoneStreamIds.length),
        unmatched: prev.unmatched + undoneStreamIds.length,
        details: prev.details.map(d => {
          const m = d.match;
          if (!m || m.unmatched || !undone.has(m.streamId)) return d;
          return { ...d, match: { ...m, unmatched: true } };
        }),
      } : prev);

      if (modifiedStreamIds.length > 0) {
        // The bulk pass leaves these alone, so the rows say why they stayed.
        setUnmatchNotices(prev => {
          const next = { ...prev };
          for (const id of modifiedStreamIds) next[id] = t('automatchUnmatchStale');
          return next;
        });
      }

      if (channel && undone.has(channel.stream_id)) {
        const target = targets.find(m => m.streamId === channel.stream_id);
        if (target) restoreChannelTabFromPrior(target.streamId, target.prior);
      }
    } catch (e) {
      console.error('[EPG Editor] Could not undo all matches:', e);
      setUndoAllError(t('automatchUndoAllFailed'));
    } finally {
      setUndoingAll(false);
      setConfirmUndoAll(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  // The list tab says where its channels came from when the caller passed a set
  // (a category), rather than "All Channels" for an entire source.
  const listTabLabel = channelList ? (channelListName || t('allChannelsTab')) : t('allChannelsTab');

  /**
   * The list tab is for callers that asked for a list (the guide's current
   * category). Opened on one channel — right-click → EPG Editor — an "All
   * Channels" list of the whole source has nothing to do with the channel in
   * front of the user, and a stray click on one of its rows silently swaps the
   * modal over to a different channel, discarding whatever was unsaved. So it is
   * only offered when the caller supplied the list.
   */
  const showListTab = Boolean(channelList) || !channel;

  /** Friendly name of the feed a lock names (a global EPG link's cache, or a playlist's feed). */
  const matchFeedLabel = useCallback(
    (feedRef: string | null): string | null =>
      feedRef ? (sourceNameMap.get(feedRef) || feedRef) : null,
    [sourceNameMap]
  );

  const matchSourceLabel = useCallback(
    (sourceId: string | null) => (sourceId ? (sourceNameMap.get(sourceId) || sourceId) : '—'),
    [sourceNameMap]
  );

  /**
   * The filtered source → category tree — see buildMatchTree for the filtering,
   * counting and ordering rules.
   */
  const matchTree = useMemo(
    () => buildMatchTree(matchRows, {
      filter: matchFilter,
      lockFilter: matchLockFilter,
      sourceLabel: matchSourceLabel,
      feedLabel: matchFeedLabel,
      categories: matchCategories,
      labels: { noCategory: t('matchesNoCategory') },
    }),
    [matchRows, matchFilter, matchLockFilter, matchCategories, matchSourceLabel, matchFeedLabel, t]
  );

  /**
   * The rows to render. Anything the search matched is shown straight away — a
   * hit behind a collapsed parent reads as "nothing found" — while an unfiltered
   * tree stays exactly as the user left it.
   */
  const matchSearchActive = matchFilter.trim().length > 0;
  const matchFlatRows = useMemo(
    () => flattenMatchTree(matchTree, { expanded: matchExpanded, expandAll: matchSearchActive }),
    [matchTree, matchExpanded, matchSearchActive]
  );
  const matchOpenNodeCount = useMemo(
    () => (matchSearchActive ? 0 : matchNodeKeys(matchTree).filter(key => matchExpanded.has(key)).length),
    [matchTree, matchExpanded, matchSearchActive]
  );
  /** How many nodes the tree holds — what "Expand all" would open. */
  const matchNodeCount = useMemo(() => matchNodeKeys(matchTree).length, [matchTree]);

  /**
   * What the tree currently holds. A source's channels are unique, so summing
   * over sources cannot double count a channel that sits in two categories.
   */
  const matchTotals = useMemo(() => matchTree.reduce(
    (acc, source) => ({
      total: acc.total + source.channels.length,
      locked: acc.locked + source.locked,
      elsewhere: acc.elsewhere + source.elsewhere,
    }),
    { total: 0, locked: 0, elsewhere: 0 }
  ), [matchTree]);
  const matchVisibleCount = matchTotals.total;
  const matchVisibleLocked = matchTotals.locked;
  const matchVisibleElsewhere = matchTotals.elsewhere;

  /** Open or close one tree node. */
  function toggleMatchNode(key: string) {
    setMatchConfirmKey(null);
    setMatchExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /**
   * Two-click bulk release for one node's channels. The scope is the locked
   * channels the node owns, so releasing a source covers its categories whether
   * or not any of them are open.
   */
  async function handleReleaseMatchNode(key: string, releaseIds: string[]) {
    if (releaseIds.length === 0) return;
    if (matchConfirmKey !== key) {
      setMatchConfirmKey(key);
      return;
    }
    setMatchConfirmKey(null);
    const released = await releaseFeedPinsForStreamIds(releaseIds);
    if (released === 0) return;
    // The cleared ids are exactly the ones this node named, so the rows are
    // patched in place: a reload would blank the tree and drop the user back at
    // the top of a list they were reading.
    const cleared = new Set(releaseIds);
    setMatchRows(prev => prev.map(r => (cleared.has(r.streamId) ? { ...r, feedRef: null } : r)));
  }

  /** Remember where the list is scrolled to — see matchScrollTopRef. */
  const handleMatchScroll = useCallback(() => {
    const el = matchListRef.current;
    if (el) matchScrollTopRef.current = el.scrollTop;
  }, []);

  /**
   * The list container's ref. Two jobs, because the container is created and
   * destroyed with the tab rather than kept alive:
   *
   *  - A native listener is re-attached to every new element. React's onScroll is
   *    not enough here: the list is both scrolled and restored by script, and the
   *    attached listener is the one thing that sees every offset.
   *  - The saved offset is re-applied the moment an element exists, which is later
   *    than the tab's own effects — those run before the list has rows to show.
   */
  const setMatchListEl = useCallback((el: HTMLDivElement | null) => {
    const previous = matchListRef.current;
    if (previous === el) return;
    if (previous) previous.removeEventListener('scroll', handleMatchScroll);
    matchListRef.current = el;
    if (!el) return;
    el.addEventListener('scroll', handleMatchScroll, { passive: true });
    const target = matchScrollTopRef.current;
    if (target > 0 && Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
  }, [handleMatchScroll]);

  /** Release one channel's lock, without leaving the report. */
  async function handleReleaseMatchRow(streamId: string) {
    const released = await releaseChannelFeedPin(streamId);
    if (!released) return;
    setMatchRows(prev => prev.map(r => (r.streamId === streamId ? { ...r, feedRef: null } : r)));
  }

  const filteredSourceChannels = sourceChannels.filter(ch =>
    !sourceFilter || ch.name.toLowerCase().includes(sourceFilter.toLowerCase())
  );

  /** Matches from the last run that are still applied — what "Undo all" takes back. */
  const automatchUndoCount = automatchResults
    ? automatchResults.details.reduce((n, d) => (d.match && !d.match.unmatched ? n + 1 : n), 0)
    : 0;

  const tabs: { key: EditorTab; label: string; icon: React.ReactNode; badge?: React.ReactNode }[] = channel
    ? [
        { key: 'channel',  label: t('channelTab'), icon: <AntennaSvg size={14} /> },
        {
          key: 'programs',
          label: t('programsTab'),
          icon: <ScheduleSvg size={14} />,
          badge: programs.length > 0 ? <span className="epg-tab-badge">{programs.length}</span> : undefined,
        },
        { key: 'search',   label: t('epgSearchTab'), icon: <SearchSvg size={14} /> },
        ...(showListTab ? [{
          key: 'source' as const,
          label: listTabLabel,
          icon: <TvSvg size={14} />,
          badge: sourceChannels.length > 0 ? <span className="epg-tab-badge">{sourceChannels.length}</span> : undefined,
        }] : []),
        {
          key: 'automatch',
          label: t('automatchTab'),
          icon: <RobotSvg size={14} />,
          badge: automatchRefusals.length > 0 ? <span className="epg-tab-badge epg-tab-badge-warning">{automatchRefusals.length}</span> : undefined,
        },
        {
          key: 'matches',
          label: t('matchesTab'),
          icon: <LockSvg size={14} />,
          badge: matchVisibleCount > 0 ? <span className="epg-tab-badge">{matchVisibleCount}</span> : undefined,
        },
      ]
    : [
        {
          key: 'source',
          label: listTabLabel,
          icon: <TvSvg size={14} />,
          badge: sourceChannels.length > 0 ? <span className="epg-tab-badge">{sourceChannels.length}</span> : undefined,
        },
        { key: 'search',   label: t('epgSearchTab'), icon: <SearchSvg size={14} /> },
        {
          key: 'automatch',
          label: t('automatchTab'),
          icon: <RobotSvg size={14} />,
          badge: automatchRefusals.length > 0 ? <span className="epg-tab-badge epg-tab-badge-warning">{automatchRefusals.length}</span> : undefined,
        },
        {
          key: 'matches',
          label: t('matchesTab'),
          icon: <LockSvg size={14} />,
          badge: matchVisibleCount > 0 ? <span className="epg-tab-badge">{matchVisibleCount}</span> : undefined,
        },
      ];

  const title = channel
    ? channel.name
    : sourceName ?? t('editorTitle');

  return createPortal(
    <div className="epg-editor-overlay" ref={overlayRef}>
      <div className="epg-editor-modal" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="epg-editor-header">
          <div className="epg-header-left">
            <span className="epg-header-icon"><EpgHeaderSvg size={20} /></span>
            <h2 className="epg-header-title">
              {t('editorTitle', { defaultValue: 'EPG Editor' })}
            </h2>
            {channel ? (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="epg-header-badge" title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {(logoUrl || channel.stream_icon) ? (
                    <img
                      src={logoUrl || channel.stream_icon}
                      alt=""
                      style={{ width: 16, height: 16, objectFit: 'contain', borderRadius: 2 }}
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <TvSvg size={12} />
                  )}
                  <span>{title}</span>
                </span>
                {channel.source_id && sourceNameMap.get(channel.source_id) && (
                  <span className="epg-badge epg-badge-muted" title={sourceNameMap.get(channel.source_id)}>
                    {sourceNameMap.get(channel.source_id)}
                  </span>
                )}
                {tvgId.trim() ? (
                  <span className="epg-badge epg-badge-success" title={tvgId}>
                    <CheckSvg size={11} />
                    <span>{t('mapped', 'Mapped')}</span>
                  </span>
                ) : (
                  <span className="epg-badge epg-badge-warning" title={t('unmapped', 'Unmapped')}>
                    <WarningSvg size={11} />
                    <span>{t('unmapped', 'Unmapped')}</span>
                  </span>
                )}
              </div>
            ) : (
              <span className="epg-header-badge" title={title}>
                {title}
              </span>
            )}
          </div>
          <div className="epg-header-right">
            <button className="epg-close-btn" onClick={onClose} title={i18n.t('common:close')}>
              <CrossSvg size={13} />
              <span>{i18n.t('common:close')}</span>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="epg-editor-tabs">
          {tabs.map(t => (
            <button
              key={t.key}
              className={`epg-editor-tab${activeTab === t.key ? ' active' : ''}`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.icon}
              <span>{t.label}</span>
              {t.badge}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="epg-editor-body">

          {/* ═══ CHANNEL TAB ═══ */}
          {activeTab === 'channel' && channel && (
            <div>
              {/* Card 1: Channel Mapping & Identity */}
              <div className="epg-editor-card">
                <div className="epg-editor-card-header">
                  <div>
                    <h3 className="epg-editor-card-title">
                      <AntennaSvg size={15} />
                      <span>{t('channelMappingTitle', 'Channel Mapping & Identity')}</span>
                    </h3>
                    <p className="epg-editor-card-desc">
                      {t('channelMappingDesc', 'Associate this channel stream with an EPG guide identifier and configure matching rules.')}
                    </p>
                  </div>
                  {tvgId.trim() ? (
                    <span className="epg-badge epg-badge-success">
                      <CheckSvg size={12} /> {t('mapped', 'Mapped')}
                    </span>
                  ) : (
                    <span className="epg-badge epg-badge-warning">
                      <WarningSvg size={12} /> {t('unmapped', 'Unmapped')}
                    </span>
                  )}
                </div>

                <div className="epg-editor-card-body">
                  <div className="epg-editor-field" style={{ margin: 0 }}>
                    <label className="epg-editor-label">{t('tvgIdLabel')}</label>
                    <input
                      className="epg-editor-input"
                      value={tvgId}
                      onChange={e => setTvgId(e.target.value)}
                      placeholder={t('tvgIdPlaceholder')}
                    />
                    <div className="epg-editor-hint">
                      {t('tvgIdHint')}
                    </div>
                    {pinnedFeed && tvgId.trim() === originalTvgId.trim() && (
                      <div className="epg-editor-hint epg-editor-pinned-feed" style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <LockSvg size={12} />
                        <span>
                          {t('pinnedFeedHint', {
                            name: sourceNameMap.get(pinnedFeed) || pinnedFeed,
                          })}
                        </span>
                      </div>
                    )}
                  </div>

                  {rawChannel && (
                    <div className="epg-editor-field" style={{ margin: 0 }}>
                      <label className="epg-editor-label">{t('matchNameLabel')}</label>
                      <div className="epg-editor-match-names">
                        <span className="epg-editor-match-name-tag">
                          <TvSvg size={13} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 4 }} />
                          {t('matchNameProvider')}
                        </span>
                        <span className="epg-editor-match-name-value" title={providerName}>
                          {providerName}
                        </span>
                        <span className="epg-editor-match-name-tag">
                          <EditSvg size={13} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 4 }} />
                          {t('matchNameAlias')}
                        </span>
                        <div className="epg-editor-match-name-control">
                          <input
                            className="epg-editor-input epg-editor-match-name-input"
                            value={matchNameDraft}
                            onChange={e => handleMatchNameChange(e.target.value)}
                            placeholder={t('matchNameCustomPlaceholder', { provider: providerName })}
                          />
                          <button
                            type="button"
                            className="epg-editor-match-name-reset"
                            onClick={handleResetMatchName}
                            disabled={!customMatchName && !matchByAlias}
                            title={t('matchNameResetToProvider')}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                          >
                            <ResetSvg size={12} />
                            <span>{t('matchNameResetToProvider')}</span>
                          </button>
                        </div>
                      </div>

                      {customMatchName && (
                        <div className="card-segmented-control" style={{ marginTop: 8 }}>
                          <button
                            type="button"
                            className={`segmented-btn ${!matchByAlias ? 'active' : ''}`}
                            onClick={() => setMatchByAlias(false)}
                            title={t('matchNameProviderTitle')}
                          >
                            <TvSvg size={13} /> {t('matchNameProvider')}
                          </button>
                          <button
                            type="button"
                            className={`segmented-btn ${matchByAlias ? 'active' : ''}`}
                            onClick={() => setMatchByAlias(true)}
                            title={t('matchNameAliasTitle')}
                          >
                            <EditSvg size={13} /> {t('matchNameAlias')}
                          </button>
                        </div>
                      )}

                      <div className="epg-editor-hint">
                        {customMatchName
                          ? (matchByAlias
                              ? t('matchNameAliasHint', {
                                  name: customMatchName,
                                  provider: providerName,
                                })
                              : t('matchNameProviderHint', {
                                  name: customMatchName,
                                  provider: providerName,
                                }))
                          : t('matchNameNoCustomName', { provider: providerName })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Card 2: Logo & Appearance Studio */}
              <div className="epg-editor-card">
                <div className="epg-editor-card-header">
                  <div>
                    <h3 className="epg-editor-card-title">
                      <ImageSvg size={15} />
                      <span>{t('logoStudioTitle', 'Branding & Logo Studio')}</span>
                    </h3>
                    <p className="epg-editor-card-desc">
                      {t('logoStudioDesc', 'Customize the channel logo, background treatment, and framing for the guide and player.')}
                    </p>
                  </div>
                </div>

                <div className="epg-editor-card-body">
                  <div className="epg-logo-grid">
                    {/* Left: Preview Stage */}
                    <div className="epg-logo-stage">
                      <div className="epg-logo-stage-box">
                        <ChannelLogo
                          src={logoUrl || undefined}
                          name={channel?.name || ''}
                          background={logoBackground}
                          defaultBackground={channel?.source_id ? sourceLogoBackgroundOverrides[channel.source_id] : undefined}
                          padding={logoPadding}
                          shape={logoShape}
                          lazy={false}
                        />
                      </div>
                      <div className="epg-logo-stage-controls">
                        <div className="card-segmented-control">
                          <button
                            type="button"
                            className={`segmented-btn ${logoBackground === 'auto' ? 'active' : ''}`}
                            onClick={() => setLogoBackground('auto')}
                            title={t('defaultBgTitle')}
                          >
                            <SparkleSvg size={12} /> {t('defaultBg')}
                            {resolvedDefaultBg !== 'auto' ? ` (${t(resolvedDefaultBg === 'light' ? 'lightBg' : 'darkBg')})` : ''}
                          </button>
                          <button
                            type="button"
                            className={`segmented-btn ${logoBackground === 'light' ? 'active' : ''}`}
                            onClick={() => setLogoBackground('light')}
                            title={t('lightBgTitle')}
                          >
                            <SunSvg size={13} /> {t('lightBg')}
                          </button>
                          <button
                            type="button"
                            className={`segmented-btn ${logoBackground === 'dark' ? 'active' : ''}`}
                            onClick={() => setLogoBackground('dark')}
                            title={t('darkBgTitle')}
                          >
                            <MoonSvg size={13} /> {t('darkBg')}
                          </button>
                        </div>
                        <div className="card-segmented-control card-padding-control">
                          {/* The padding control mirrors the background one above it:
                              a Default that follows the global setting, then the two
                              explicit choices. Without the Default option a channel
                              would be stuck on whichever option was clicked first,
                              with no way back to the setting it was following. */}
                          <button
                            type="button"
                            className={`segmented-btn ${logoPadding === undefined ? 'active' : ''}`}
                            onClick={() => setLogoPadding(undefined)}
                            title={t('paddingDefaultTitle')}
                          >
                            <SparkleSvg size={12} /> {i18n.t('common:default')}
                          </button>
                          <button
                            type="button"
                            className={`segmented-btn ${logoPadding === 'default' ? 'active' : ''}`}
                            onClick={() => setLogoPadding('default')}
                            title={t('normalPaddingTitle')}
                          >
                            <RulerSvg size={13} /> {t('normalPadding')}
                          </button>
                          <button
                            type="button"
                            className={`segmented-btn ${logoPadding === 'none' ? 'active' : ''}`}
                            onClick={() => setLogoPadding('none')}
                            title={t('noPadTitle')}
                          >
                            <ImageSvg size={13} /> {t('noPad')}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Right: URL & Quick Select */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div className="epg-editor-field" style={{ margin: 0 }}>
                        <label className="epg-editor-label">{t('logoUrlLabel')}</label>
                        <input
                          className="epg-editor-input"
                          value={logoUrl}
                          onChange={e => setLogoUrl(e.target.value)}
                          placeholder={t('logoUrlPlaceholder')}
                        />
                        <div className="epg-editor-hint">
                          {t('logoBgHint')}
                        </div>
                      </div>

                      {(() => {
                        const playlistIcon = rawChannel?.stream_icon || channel.stream_icon;
                        if (!playlistIcon && !epgLogoUrl) return null;
                        return (
                          <div className="epg-editor-field" style={{ margin: 0 }}>
                            <label className="epg-editor-label">{t('quickSelectLogo')}</label>
                            <div className="epg-quick-select-row">
                              {playlistIcon && (
                                <button
                                  type="button"
                                  className={`epg-quick-select-chip${logoUrl === playlistIcon ? ' active' : ''}`}
                                  onClick={() => setLogoUrl(playlistIcon)}
                                  title={t('playlistLogo')}
                                >
                                  <img src={playlistIcon} alt="" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                  <span>{t('playlistLogo')}</span>
                                </button>
                              )}
                              {epgLogoUrl && (
                                <button
                                  type="button"
                                  className={`epg-quick-select-chip${logoUrl === epgLogoUrl ? ' active' : ''}`}
                                  onClick={() => setLogoUrl(epgLogoUrl)}
                                  title={t('epgLogo')}
                                >
                                  <img src={epgLogoUrl} alt="" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                  <span>{t('epgLogo')}</span>
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 3: Broadcast Timing & Schedule Offset */}
              <div className="epg-editor-card">
                <div className="epg-editor-card-header">
                  <div>
                    <h3 className="epg-editor-card-title">
                      <ScheduleSvg size={15} />
                      <span>{t('timeOffsetTitle', 'Broadcast Timing & Schedule Offset')}</span>
                    </h3>
                    <p className="epg-editor-card-desc">
                      {t('timeOffsetDesc', 'Adjust EPG program schedule alignment if broadcasts are delayed or ahead of guide listings.')}
                    </p>
                  </div>
                </div>

                <div className="epg-editor-card-body">
                  <div className="epg-editor-field" style={{ margin: 0 }}>
                    <label className="epg-editor-label">{t('timeOffsetLabel')}</label>
                    <div className="epg-timeshift-deck">
                      {[-2, -1, 0, 1, 2].map(preset => {
                        const label = preset === 0 ? '0h' : preset > 0 ? `+${preset}h` : `${preset}h`;
                        const active = Number(timeshiftHours) === preset;
                        return (
                          <button
                            key={preset}
                            type="button"
                            className={`epg-preset-pill${active ? ' active' : ''}`}
                            onClick={() => setTimeshiftHours(String(preset))}
                          >
                            {label}
                          </button>
                        );
                      })}
                      <div className="epg-editor-timeshift-row" style={{ marginLeft: 'auto' }}>
                        <input
                          type="number"
                          step="0.5"
                          min="-24"
                          max="24"
                          className="epg-editor-timeshift-input"
                          value={timeshiftHours}
                          onChange={e => setTimeshiftHours(e.target.value)}
                        />
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary, #888)' }}>
                          {t('timeOffsetHint')}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Danger Zone */}
              <div className="epg-danger-zone">
                <div className="epg-danger-zone-info">
                  <div className="epg-danger-zone-title">
                    <WarningSvg size={14} />
                    <strong>{t('resetChannel')}</strong>
                  </div>
                  <div className="epg-danger-zone-desc">{t('resetChannelDesc')}</div>
                </div>
                <button
                  className="epg-editor-btn epg-editor-btn-danger"
                  onClick={handleResetToDefault}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <ResetSvg size={13} />
                  <span>{t('resetToDefault')}</span>
                </button>
              </div>
            </div>
          )}

          {/* ═══ PROGRAMS TAB ═══ */}
          {activeTab === 'programs' && channel && (
            <div>
              <div className="epg-editor-programs-toolbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary, #888)' }}>
                    {t('showingProgramsRange')} <strong>{channel.name}</strong>
                  </span>
                  {programs.length > 0 && (
                    <span className="epg-tab-badge">
                      {programs.length} {t('programs', 'programs')}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {targetScrollProgramId && (
                    <button
                      type="button"
                      className="epg-editor-btn"
                      style={{ padding: '7px 12px', fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      onClick={() => scrollToCurrentProgram(true)}
                      title={currentProgramId ? t('jumpToCurrent', 'Scroll to currently airing program') : t('jumpToUpcoming', 'Scroll to next upcoming program')}
                    >
                      <ScheduleSvg size={13} />
                      <span>{currentProgramId ? i18n.t('common:now') : t('start', 'Upcoming')}</span>
                    </button>
                  )}
                  <button
                    className="epg-editor-btn epg-editor-btn-primary"
                    style={{ padding: '7px 14px', fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    onClick={() => setShowAddForm(v => !v)}
                  >
                    {showAddForm ? <><CrossSvg size={12} /> <span>{i18n.t('common:cancel')}</span></> : <><PlusSvg size={12} /> <span>{t('addProgram')}</span></>}
                  </button>
                </div>
              </div>

              {(pinnedFeed || pinnedInPlaylist > 0) && (
                <div className="epg-editor-feed-pin-bar">
                  {pinnedFeed && (
                    <span className="epg-editor-feed-pin-chip">
                      <span className="epg-editor-feed-pin-dot" aria-hidden="true" />
                      {t('pinnedFeedHint', {
                        name: sourceNameMap.get(pinnedFeed) || pinnedFeed,
                      })}
                      <button
                        className="epg-editor-btn"
                        style={{ padding: '3px 10px', fontSize: '0.75rem' }}
                        onClick={async () => {
                          if (!channel) return;
                          await releaseChannelFeedPin(channel.stream_id);
                          setPinnedFeed(undefined);
                          setPinnedInPlaylist(await countFeedPinsInSource(channel.source_id));
                        }}
                      >
                        {t('releaseFeedPin')}
                      </button>
                    </span>
                  )}
                  {pinnedInPlaylist > 0 && channel && (
                    <span className="epg-editor-feed-pin-playlist">
                      {t('feedPinsInPlaylist')} <strong>{pinnedInPlaylist}</strong>
                      <button
                        className={`epg-editor-btn${confirmReleaseAll ? ' epg-editor-btn-primary' : ''}`}
                        style={{ padding: '3px 10px', fontSize: '0.75rem' }}
                        onClick={async () => {
                          if (!confirmReleaseAll) {
                            setConfirmReleaseAll(true);
                            return;
                          }
                          setConfirmReleaseAll(false);
                          await releaseFeedPinsInSource(channel.source_id);
                          setPinnedInPlaylist(0);
                          setPinnedFeed(undefined);
                        }}
                      >
                        {confirmReleaseAll ? t('confirmReleaseAllFeedPins') : t('releaseAllFeedPins')}
                      </button>
                    </span>
                  )}
                </div>
              )}

              {showAddForm && (
                <div className="epg-editor-card" style={{ borderColor: 'rgba(0, 212, 255, 0.3)', background: 'rgba(0, 212, 255, 0.03)' }}>
                  <div className="epg-editor-card-header">
                    <h3 className="epg-editor-card-title">
                      <PlusSvg size={14} />
                      <span>{t('addProgram')}</span>
                    </h3>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div style={{ gridColumn: '1/-1' }}>
                      <label className="epg-editor-label">{t('titleRequired')}</label>
                      <input className="epg-editor-input" value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder={t('programTitlePlaceholder')} />
                    </div>
                    <div style={{ gridColumn: '1/-1' }}>
                      <label className="epg-editor-label">{t('subtitle')}</label>
                      <input className="epg-editor-input" value={newSubtitle} onChange={e => setNewSubtitle(e.target.value)} placeholder={t('optionalSubtitle')} />
                    </div>
                    <div style={{ gridColumn: '1/-1' }}>
                      <label className="epg-editor-label">{t('description')}</label>
                      <textarea className="epg-editor-textarea" value={newDesc} rows={2} onChange={e => setNewDesc(e.target.value)} placeholder={t('optionalDescription')} />
                    </div>
                    <div>
                      <label className="epg-editor-label">{t('startRequired')}</label>
                      <input type="datetime-local" className="epg-editor-input" value={newStart} onChange={e => setNewStart(e.target.value)} />
                    </div>
                    <div>
                      <label className="epg-editor-label">{t('endRequired')}</label>
                      <input type="datetime-local" className="epg-editor-input" value={newEnd} onChange={e => setNewEnd(e.target.value)} />
                    </div>
                    <div style={{ gridColumn: '1/-1', display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                      <button
                        className="epg-editor-btn epg-editor-btn-secondary"
                        onClick={() => setShowAddForm(false)}
                      >
                        {i18n.t('common:cancel')}
                      </button>
                      <button
                        className="epg-editor-btn epg-editor-btn-primary"
                        onClick={handleAddCustomProgram}
                        disabled={!newTitle.trim() || !newStart || !newEnd}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      >
                        <CheckSvg size={12} />
                        <span>{t('addProgram')}</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {programsLoading ? (
                <div className="epg-editor-loading">{t('loadingPrograms')}</div>
              ) : programs.length === 0 ? (
                <div className="epg-editor-empty">
                  {t('noProgramsRange')}<br />
                  <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>{t('syncSourceHint')}</span>
                </div>
              ) : (
                <div className="epg-programs-list">
                  {programs.map(prog => (
                    <ProgramRow
                      key={prog.id}
                      prog={prog}
                      isCurrent={prog.id === currentProgramId}
                      rowRef={prog.id === targetScrollProgramId ? currentProgramRowRef : undefined}
                      onSave={changes => handleProgramSave(prog, changes)}
                      onDelete={() => handleProgramDelete(prog)}
                      onRestore={() => handleProgramRestore(prog)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ═══ EPG SEARCH TAB ═══ */}
          {activeTab === 'search' && (
            <div>
              <div style={{ marginBottom: 10, fontSize: '0.82rem', color: 'var(--text-secondary, #888)' }}>
                {searchMode === 'epg'
                  ? <>{t('searchEpgHint1')} <strong>{t('apply')}</strong> {t('toLinkIt')}{' '}</>
                  : <>{t('searchEpgHint2')} <strong>{t('apply')}</strong> {t('toLinkIt')}{' '}</>
                }
                <strong>{channel?.name ?? t('theSelectedChannel')}</strong>.
                {searchMode === 'epg' && (
                  <span style={{ display: 'block', marginTop: 4, fontSize: '0.78rem', color: 'var(--text-secondary, #888)', opacity: 0.8 }}>
                    {t('searchEpgHintExtra')}
                  </span>
                )}
              </div>

              <div className="epg-search-deck">
                <div className="epg-search-toolbar" style={{ margin: 0 }}>
                  <div className="epg-search-input-wrap">
                    <span className="epg-search-icon"><SearchSvg size={14} /></span>
                    <input
                      className="epg-editor-input"
                      placeholder={t('searchPlaceholder')}
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      autoFocus
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        style={{
                          position: 'absolute',
                          right: 8,
                          top: '50%',
                          transform: 'translateY(-50%)',
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--text-secondary, #888)',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          padding: 2,
                        }}
                        title={i18n.t('common:clearAll')}
                      >
                        <CrossSvg size={11} />
                      </button>
                    )}
                  </div>
                  <div className="epg-search-scope-toggle">
                    <button
                      className={`epg-search-scope-btn${searchScope === 'source' ? ' active' : ''}`}
                      onClick={() => setSearchScope('source')}
                    >{t('thisSource')}</button>
                    <button
                      className={`epg-search-scope-btn${searchScope === 'all' ? ' active' : ''}`}
                      onClick={() => setSearchScope('all')}
                    >{t('allSources')}</button>
                  </div>
                  <div className="epg-search-scope-toggle">
                    <button
                      className={`epg-search-scope-btn${searchMode === 'm3u' ? ' active' : ''}`}
                      onClick={() => setSearchMode('m3u')}
                      title={t('searchM3uTitle')}
                    >{t('m3uNames')}</button>
                    <button
                      className={`epg-search-scope-btn${searchMode === 'epg' ? ' active' : ''}`}
                      onClick={() => setSearchMode('epg')}
                      title={t('searchEpgNamesTitle')}
                    >{t('epgNames')}</button>
                  </div>
                  {channel && (
                    <button
                      className="epg-search-auto-btn"
                      onClick={handleAutoSuggest}
                      disabled={autoSearching}
                      title={t('scoreAllTitle')}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                      {autoSearching ? '…' : <><SparkleSvg size={13} /> <span>{t('autoMatch')}</span></>}
                    </button>
                  )}
                </div>
              </div>

              {!channel && (
                <div style={{
                  padding: '10px 14px', borderRadius: 8, marginBottom: 12,
                  background: 'rgba(255,165,0,0.08)', border: '1px solid rgba(255,165,0,0.2)',
                  fontSize: '0.82rem', color: 'var(--status-warning-text, #ffaa44)',
                }}>
                  {t('openChannelFirst')}
                </div>
              )}

              {searchLoading && <div className="epg-editor-loading">{t('searching')}</div>}

              {!searchLoading && searchQuery && searchResults.length === 0 && (
                <div className="epg-editor-empty">{t('noEpgMatched', { query: searchQuery })}</div>
              )}

              {!searchLoading && searchResults.length > 0 && (
                <div className="epg-search-results">
                  {searchResults.map((r, i) => {
                    const isPreviewOpen = previewResult?.id === r.id && previewResult?.source_id === r.source_id;
                    const pct = Math.round(r.score * 100);
                    const scoreClass = r.score >= 0.85 ? 'high' : r.score >= 0.60 ? 'medium' : r.score >= 0.35 ? 'low' : 'poor';
                    return (
                      <div key={r.id + r.source_id}>
                        <div
                          className={`epg-search-result-row${i === 0 && r.score > 0.5 ? ' best-match' : ''}${isPreviewOpen ? ' selected-preview' : ''}`}
                          onClick={() => setPreviewResult(isPreviewOpen ? null : r)}
                          style={{ cursor: 'pointer' }}
                        >
                          {r.icon_url ? (
                            <img src={r.icon_url} alt="" className="epg-search-result-icon"
                              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                          ) : (
                            <div className="epg-search-result-placeholder">
                              <TvSvg size={16} />
                            </div>
                          )}
                          <div className="epg-search-result-info">
                            <div className="epg-search-result-name">{r.display_name}</div>
                            <div className="epg-search-result-id">{r.id}</div>
                            {searchScope === 'all' && (
                              <div className="epg-search-result-source">{t('sourceLabel2', { name: sourceNameMap.get(r.source_id) ?? r.source_id })}</div>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary, #888)', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              {isPreviewOpen ? <><ChevronUpSvg size={10} /> <span>{t('hide')}</span></> : <><ChevronDownSvg size={10} /> <span>{t('programs')}</span></>}
                            </span>
                            <span className={`epg-score-badge ${scoreClass}`} title={t('matchScore', { score: pct })}>
                              {pct}%
                            </span>
                            {channel && (
                              <button
                                className="epg-search-apply-btn"
                                disabled={applyingId === r.id}
                                onClick={e => { e.stopPropagation(); handleApplyMatch(r); }}
                              >
                                {applyingId === r.id ? '…' : t('apply')}
                              </button>
                            )}
                          </div>
                        </div>
                        
                        {/* Inline program preview panel for THIS search result */}
                        {isPreviewOpen && (
                          <div style={{
                            margin: '4px 0 10px 0', border: '1px solid rgba(0,212,255,0.2)',
                            borderRadius: 8, overflow: 'hidden',
                            background: 'rgba(0,0,0,0.25)',
                          }}>
                            <div style={{
                              padding: '8px 14px', background: 'rgba(0,212,255,0.08)',
                              fontSize: '0.8rem', color: '#fff', fontWeight: 600
                            }}>
                              {t('programsFor')} <strong>{r.display_name}</strong>
                            </div>
                            {previewLoading ? (
                              <div className="epg-editor-loading" style={{ margin: '10px 0' }}>{t('loadingPrograms')}</div>
                            ) : previewPrograms.length === 0 ? (
                              <div className="epg-editor-empty" style={{ padding: '12px 14px' }}>
                                {t('noProgramsFound')}
                              </div>
                            ) : (
                              <div style={{ maxHeight: 200, overflowY: 'auto', padding: '4px 0' }}>
                                {previewPrograms.map(p => (
                                  <div key={p.id} style={{
                                    display: 'flex', gap: 12, padding: '6px 14px',
                                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                                    fontSize: '0.81rem',
                                  }}>
                                    <span style={{ color: 'var(--text-secondary, #888)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                      {formatShortDatetime(p.start, epgClockFormat)}
                                    </span>
                                    <span style={{ color: '#fff' }}>{p.title}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {!searchQuery && !searchLoading && (
                <div className="epg-editor-empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  <SearchSvg size={28} />
                  <div>
                    {t('typeToSearch')} <strong style={{ color: 'var(--accent-primary, #00d4ff)' }}>{t('autoMatch')}</strong> {t('toFindBestMatch')} <strong>{channel?.name ?? t('yourChannel')}</strong>.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══ SOURCE / ALL CHANNELS TAB ═══ */}
          {activeTab === 'source' && (
            <div>
              <div className="epg-source-filter">
                <input
                  className="epg-editor-input"
                  placeholder={t('filterChannels', {
                    source: channelList ? `${channelListName ?? ''} ` : (resolvedSourceId ? `${sourceName ?? ''} ` : ''),
                  })}
                  value={sourceFilter}
                  onChange={e => setSourceFilter(e.target.value)}
                />
              </div>
              {sourceLoading ? (
                <div className="epg-editor-loading">{t('loadingChannels')}</div>
              ) : filteredSourceChannels.length === 0 ? (
                <div className="epg-editor-empty">{t('noChannelsFound')}</div>
              ) : (
                <div ref={sourceListRef} className="epg-source-channel-list">
                  {/*
                    A source can hold tens of thousands of channels and every row
                    mounts an icon and a logo request, so only the visible window is
                    rendered. Rows are wrapped so the 5px spacing sits inside the
                    measured height: virtual rows are positioned absolutely, which
                    the flex `gap` this list used to rely on does not survive.
                  */}
                  <VirtualList
                    scrollRef={sourceListRef}
                    items={filteredSourceChannels}
                    estimateItemHeight={57}
                    overscan={8}
                    getKey={ch => ch.stream_id}
                    renderItem={ch => (
                      <div style={{ paddingBottom: 5 }}>
                        <div
                          className="epg-source-channel-row"
                          onClick={() => handleOpenSourceChannel(ch)}
                          title={t('clickToEdit')}
                        >
                          {ch.stream_icon ? (
                            <img
                              key={ch.stream_icon}
                              src={ch.stream_icon}
                              alt=""
                              className="epg-source-channel-icon"
                              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                          ) : (
                            <div className="epg-source-channel-placeholder">
                              <TvSvg size={16} />
                            </div>
                          )}
                          <div className="epg-source-channel-name">{ch.name}</div>
                          <div className="epg-source-channel-tvgid">{ch.epg_channel_id || '—'}</div>
                          {overriddenIds.has(ch.stream_id) && (
                            <div className="epg-override-dot" title={t('hasOverrides')} />
                          )}
                          <span style={{ color: 'var(--text-secondary,#666)', display: 'inline-flex', alignItems: 'center' }}>
                            <ChevronRightSvg size={13} />
                          </span>
                        </div>
                      </div>
                    )}
                  />
                </div>
              )}
            </div>
          )}

          {/* ═══ AUTOMATCH MISSING TAB ═══ */}
          {activeTab === 'automatch' && (
            <div>
              {/* Card 1: Target Scope */}
              <div className="epg-editor-card">
                <div className="epg-editor-card-header">
                  <div>
                    <h3 className="epg-editor-card-title">
                      <RobotSvg size={15} />
                      <span>{t('targetScopeTitle', 'Target Scope & Sources')}</span>
                    </h3>
                    <p className="epg-editor-card-desc">
                      {t('targetScopeDesc', 'Define which playlist channels are evaluated and which EPG sources to query.')}
                    </p>
                  </div>
                </div>

                <div className="epg-editor-card-body">
                  {/* Source selection */}
                  <div className="epg-editor-field" style={{ margin: 0 }}>
                    <label className="epg-editor-label">{t('sourceLabel')}</label>
                    <select
                      className="epg-editor-input"
                      value={automatchSourceId}
                      onChange={e => setAutomatchSourceId(e.target.value)}
                      disabled={(automatchChannelScope === 'all' && automatchEpgScope === 'all') || automatchRunning}
                      style={{ cursor: 'pointer' }}
                    >
                      {automatchSources.map(s => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>

                  {/* Channels to Match toggle */}
                  <div className="epg-editor-field" style={{ margin: 0 }}>
                    <label className="epg-editor-label">{t('channelsToMatch', 'Channels to Match')}</label>
                    <div className="epg-search-scope-toggle">
                      <button
                        className={`epg-search-scope-btn${automatchChannelScope === 'source' ? ' active' : ''}`}
                        onClick={() => setAutomatchChannelScope('source')}
                        disabled={automatchRunning}
                      >{t('thisSource')}</button>
                      <button
                        className={`epg-search-scope-btn${automatchChannelScope === 'all' ? ' active' : ''}`}
                        onClick={() => setAutomatchChannelScope('all')}
                        disabled={automatchRunning}
                      >{t('allSources')}</button>
                    </div>
                  </div>

                  {/* EPG Sources to Search toggle */}
                  <div className="epg-editor-field" style={{ margin: 0 }}>
                    <label className="epg-editor-label">{t('epgSourcesToSearch', 'EPG Sources to Search')}</label>
                    <div className="epg-search-scope-toggle">
                      <button
                        className={`epg-search-scope-btn${automatchEpgScope === 'source' ? ' active' : ''}`}
                        onClick={() => setAutomatchEpgScope('source')}
                        disabled={automatchRunning}
                      >{t('thisSourceEpg', "This Source's EPG")}</button>
                      <button
                        className={`epg-search-scope-btn${automatchEpgScope === 'all' ? ' active' : ''}`}
                        onClick={() => setAutomatchEpgScope('all')}
                        disabled={automatchRunning}
                      >{t('allEpgSources', 'All EPG Sources')}</button>
                    </div>
                  </div>

                  {/* Category selection */}
                  {automatchChannelScope === 'source' && sourceCategories.length > 0 && (
                    <div className="epg-editor-field" style={{ margin: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <label className="epg-editor-label" style={{ margin: 0 }}>{t('categories')}</label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.82rem', color: 'var(--text-secondary, #aaa)' }}>
                          <input
                            type="checkbox"
                            checked={automatchAllCategories}
                            onChange={e => setAutomatchAllCategories(e.target.checked)}
                            disabled={automatchRunning}
                          />
                          {t('allCategoriesInSource')}
                        </label>
                      </div>
                      {!automatchAllCategories && (
                        <div className="epg-automatch-category-grid">
                          {sourceCategories.map(cat => (
                            <label key={cat.category_id} className="epg-automatch-category-item">
                              <input
                                type="checkbox"
                                checked={automatchCategories.includes(cat.category_id)}
                                onChange={e => {
                                  if (e.target.checked) {
                                    setAutomatchCategories(prev => [...prev, cat.category_id]);
                                  } else {
                                    setAutomatchCategories(prev => prev.filter(id => id !== cat.category_id));
                                  }
                                }}
                                disabled={automatchRunning}
                              />
                              <span>{cat.category_name}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Enabled-only scope */}
                  <div className="epg-editor-field" style={{ margin: 0 }}>
                    <label
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: automatchRunning ? 'default' : 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={enabledOnly}
                        onChange={e => setEpgAutomatchEnabledOnly(e.target.checked)}
                        disabled={automatchRunning}
                      />
                      <span className="epg-editor-label" style={{ margin: 0 }}>{t('enabledOnlyLabel')}</span>
                    </label>
                    <div className="epg-editor-hint">
                      {t('enabledOnlyHint')}
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 2: Precision & Matching Engine */}
              <div className="epg-editor-card">
                <div className="epg-editor-card-header">
                  <div>
                    <h3 className="epg-editor-card-title">
                      <SparkleSvg size={15} />
                      <span>{t('engineRulesTitle', 'Precision & Matching Engine')}</span>
                    </h3>
                    <p className="epg-editor-card-desc">
                      {t('engineRulesDesc', 'Tune the string similarity algorithm, match threshold, and noise reduction filters.')}
                    </p>
                  </div>
                </div>

                <div className="epg-editor-card-body">
                  {/* Search mode toggle */}
                  <div className="epg-editor-field" style={{ margin: 0 }}>
                    <label className="epg-editor-label">{t('matchAgainst')}</label>
                    <div className="epg-search-scope-toggle">
                      <button
                        className={`epg-search-scope-btn${automatchMode === 'm3u' ? ' active' : ''}`}
                        onClick={() => setAutomatchMode('m3u')}
                        disabled={automatchRunning}
                        title={t('searchM3uTitle')}
                      >{t('m3uNames')}</button>
                      <button
                        className={`epg-search-scope-btn${automatchMode === 'epg' ? ' active' : ''}`}
                        onClick={() => setAutomatchMode('epg')}
                        disabled={automatchRunning}
                        title={t('searchEpgNamesTitle')}
                      >{t('epgNames')}</button>
                    </div>
                  </div>

                  {/* Threshold slider */}
                  <div className="epg-editor-field" style={{ margin: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label className="epg-editor-label" style={{ margin: 0 }}>
                        {t('minMatchThreshold')}
                      </label>
                      <span className={`epg-score-badge ${automatchThreshold >= 85 ? 'high' : automatchThreshold >= 70 ? 'medium' : 'low'}`}>
                        {automatchThreshold}% ({automatchThreshold >= 85 ? t('thresholdStrict', 'Strict') : automatchThreshold >= 70 ? t('thresholdBalanced', 'Balanced') : t('thresholdPermissive', 'Permissive')})
                      </span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      step={5}
                      value={automatchThreshold}
                      onChange={e => setAutomatchThreshold(Number(e.target.value))}
                      disabled={automatchRunning}
                      className="epg-automatch-slider"
                    />
                    <div className="epg-editor-hint">
                      {t('thresholdHint')}
                    </div>
                  </div>

                  {/* Opt-in decorated-name handling */}
                  <div className="epg-editor-field" style={{ margin: 0 }}>
                    <label
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: automatchRunning ? 'default' : 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={epgAutomatchCleanNames}
                        onChange={e => setEpgAutomatchCleanNames(e.target.checked)}
                        disabled={automatchRunning}
                      />
                      <span className="epg-editor-label" style={{ margin: 0 }}>{t('cleanNamesLabel')}</span>
                    </label>
                    <div className="epg-editor-hint">
                      {t('cleanNamesHint')}
                    </div>
                    {epgAutomatchCleanNames && (
                      <div style={{ marginTop: 10 }}>
                        <label className="epg-editor-label">
                          {t('stripTagsLabel')}
                        </label>
                        <input
                          className="epg-editor-input"
                          value={stripTagsInput}
                          onChange={e => {
                            setStripTagsInput(e.target.value);
                            setEpgAutomatchStripTags(parseStripTags(e.target.value));
                          }}
                          onBlur={() => {
                            setEpgAutomatchStripTags(parseStripTags(stripTagsInput));
                          }}
                          placeholder={t('stripTagsPlaceholder')}
                          disabled={automatchRunning}
                        />
                        <div className="epg-editor-hint">
                          {t('stripTagsHint')}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Card 3: Execution Deck & Results */}
              <div className="epg-editor-card">
                <div className="epg-editor-card-header">
                  <div>
                    <h3 className="epg-editor-card-title">
                      <SparkleSvg size={15} />
                      <span>{t('executionDeckTitle', 'Execute Automatch & Review Results')}</span>
                    </h3>
                    <p className="epg-editor-card-desc">
                      {t('executionDeckDesc', 'Launch the automatch sweep across your channels and inspect real-time outcomes.')}
                    </p>
                  </div>
                </div>

                <div className="epg-editor-card-body">
                  {/* Action button */}
                  <div>
                    <button
                      className="epg-editor-btn epg-editor-btn-primary"
                      onClick={handleAutoMatchMissing}
                      disabled={automatchRunning || ((automatchChannelScope === 'source' || automatchEpgScope === 'source') && !automatchSourceId) || (automatchChannelScope === 'source' && !automatchAllCategories && automatchCategories.length === 0)}
                      style={{ width: '100%', padding: '12px 22px', fontSize: '0.95rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                    >
                      {automatchRunning && automatchProgress
                        ? t('matchingProgress', { matched: automatchProgress.matched, total: automatchProgress.total })
                        : <><RobotSvg size={16} /> <span>{t('automatchMissingBtn')}</span></>}
                    </button>
                  </div>

                  {/* Progress bar */}
                  {automatchRunning && automatchProgress && automatchProgress.total > 0 && (
                    <div>
                      <div style={{
                        height: 6,
                        background: 'var(--bg-tertiary, rgba(255,255,255,0.05))',
                        borderRadius: 3,
                        overflow: 'hidden',
                      }}>
                        <div style={{
                          height: '100%',
                          width: `${(automatchProgress.matched / automatchProgress.total) * 100}%`,
                          background: 'var(--accent-primary, #00d4ff)',
                          borderRadius: 3,
                          transition: 'width 0.2s ease-out',
                        }} />
                      </div>
                      <div style={{ textAlign: 'center', marginTop: 6, fontSize: '0.8rem', color: 'var(--text-secondary, #888)' }}>
                        {t('channelsProcessed', { matched: automatchProgress.matched, total: automatchProgress.total })}
                      </div>
                    </div>
                  )}

                  {/* Results */}
                  {automatchResults && (
                    <div style={{
                      border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
                      borderRadius: 10,
                      background: 'var(--bg-tertiary, rgba(255,255,255,0.03))',
                      overflow: 'hidden',
                      marginTop: 8,
                    }}>
                      {/* Metric Cards Summary */}
                      <div className="epg-stats-deck" style={{ margin: 0, padding: 12, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        <div className="epg-stat-card">
                          <span className="epg-stat-val epg-signal-success">{automatchResults.matched}</span>
                          <span className="epg-stat-lbl">{t('matched')}</span>
                        </div>
                        <div className="epg-stat-card">
                          <span className="epg-stat-val epg-signal-warning">{automatchResults.ambiguous}</span>
                          <span className="epg-stat-lbl">{t('ambiguous')}</span>
                        </div>
                        <div className="epg-stat-card">
                          <span className="epg-stat-val">{automatchResults.skipped}</span>
                          <span className="epg-stat-lbl">{t('skipped')}</span>
                        </div>
                        <div className="epg-stat-card">
                          <span className={`epg-stat-val${automatchResults.errors > 0 ? ' epg-signal-danger' : ''}`}>{automatchResults.errors}</span>
                          <span className="epg-stat-lbl">{t('errors')}</span>
                        </div>
                      </div>

                      {/* Log Toolbar & Filters */}
                      <div className="epg-log-filters">
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary, #888)', marginRight: 4 }}>
                          {t('filter', 'Filter')}:
                        </span>
                        {(['all', 'success', 'warning', 'error', 'skipped'] as const).map(flt => (
                          <button
                            key={flt}
                            type="button"
                            className={`epg-log-filter-pill${automatchLogFilter === flt ? ' active' : ''}`}
                            onClick={() => setAutomatchLogFilter(flt)}
                          >
                            {flt === 'all' ? i18n.t('common:all') : t(flt, flt)}
                          </button>
                        ))}
                        {automatchUndoCount > 0 && (
                          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                            {confirmUndoAll ? (
                              <>
                                <button
                                  className="epg-automatch-unmatch epg-automatch-undo-all"
                                  onClick={() => setConfirmUndoAll(false)}
                                  disabled={undoingAll}
                                >
                                  {i18n.t('common:cancel')}
                                </button>
                                <button
                                  className="epg-automatch-unmatch epg-automatch-undo-all epg-automatch-undo-all-confirm"
                                  onClick={handleUndoAllMatches}
                                  disabled={undoingAll}
                                >
                                  {undoingAll ? '…' : t('automatchUndoAllConfirm', { count: automatchUndoCount })}
                                </button>
                              </>
                            ) : (
                              <button
                                className="epg-automatch-unmatch epg-automatch-undo-all"
                                onClick={() => setConfirmUndoAll(true)}
                                disabled={unmatchingId !== null || undoingAll}
                                title={t('automatchUndoAllHint')}
                              >
                                {t('automatchUndoAll')}
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {undoAllError && (
                        <div className="epg-automatch-undo-error">{undoAllError}</div>
                      )}

                      <div
                        ref={automatchListRef}
                        style={{ maxHeight: 280, overflowY: 'auto', padding: '6px 0' }}
                      >
                        <VirtualList
                          scrollRef={automatchListRef}
                          items={filteredAutomatchDetails}
                          estimateItemHeight={26}
                          overscan={10}
                          getKey={(_, index) => index}
                          renderItem={(detail) => {
                            const match = detail.match;
                            const busy = match ? unmatchingId === match.streamId : false;
                            const notice = match ? unmatchNotices[match.streamId] : undefined;
                            const isSuccess = detail.type === 'success' || detail.text.startsWith('✓');
                            const isWarning = detail.type === 'warning' || detail.text.startsWith('⚠');
                            const isError = detail.type === 'error' || detail.text.startsWith('✗');
                            const isSkipped = detail.type === 'skipped';
                            const hasIcon = isSuccess || isWarning || isError || isSkipped;
                            const cleanText = detail.text.replace(/^[✓⚠✗]\s*/, '');

                            return (
                              <div className="epg-automatch-detail">
                                {hasIcon && (
                                  <span
                                    className={
                                      isSuccess ? 'epg-signal-success-text'
                                        : isWarning ? 'epg-signal-warning-text'
                                        : isError ? 'epg-signal-danger-text'
                                        : 'epg-signal-muted'
                                    }
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      flexShrink: 0,
                                      marginTop: 2,
                                      marginRight: 6,
                                    }}
                                  >
                                    {isSuccess && <CheckSvg size={12} />}
                                    {isWarning && <WarningSvg size={12} />}
                                    {(isError || isSkipped) && <CrossSvg size={12} />}
                                  </span>
                                )}
                                <span
                                  className={
                                    `epg-automatch-detail-text ${isSuccess ? 'epg-signal-success-text'
                                      : isWarning ? 'epg-signal-warning-text'
                                      : 'epg-signal-muted'}`
                                  }
                                >
                                  {cleanText}
                                </span>
                                {match && !match.unmatched && (
                                  <button
                                    className="epg-automatch-unmatch"
                                    onClick={() => handleUnmatchMatch(match)}
                                    disabled={unmatchingId !== null || undoingAll}
                                    title={t('automatchUnmatchHint')}
                                  >
                                    {busy ? '…' : t('automatchUnmatch')}
                                  </button>
                                )}
                                {match?.unmatched && (
                                  <span className="epg-automatch-unmatched">{t('automatchUnmatched')}</span>
                                )}
                                {notice && <span className="epg-automatch-notice">{notice}</span>}
                              </div>
                            );
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Ambiguity worklist */}
                  {automatchRefusals.length > 0 && (
                    <div className="epg-refusal-panel" style={{ marginTop: 12 }}>
                      <div className="epg-refusal-header">
                        <span className="epg-refusal-title">
                          {t('ambiguousWorklistTitle', { count: automatchRefusals.length })}
                        </span>
                        <button
                          className="epg-refusal-dismiss-all"
                          onClick={() => setAutomatchRefusals([])}
                          disabled={resolvingRefusal !== null}
                        >
                          {t('ambiguousDismissAll')}
                        </button>
                      </div>
                      <div className="epg-editor-hint" style={{ marginBottom: 8 }}>
                        {t('ambiguousWorklistHint')}
                      </div>
                      <div className="epg-refusal-list">
                        {automatchRefusals.map(refusal => {
                          const busy = resolvingRefusal === refusal.streamId;
                          const hidden = refusal.totalChoices - refusal.choices.length;
                          return (
                            <div key={refusal.streamId} className="epg-refusal-row">
                              <div className="epg-refusal-row-head">
                                <span className="epg-refusal-channel" title={refusal.channelName}>
                                  {refusal.channelName}
                                </span>
                                <span className="epg-refusal-cleaned">
                                  {t('ambiguousCleanedAs', { name: refusal.cleanedName })}
                                  {hidden > 0 ? ` +${hidden}` : ''}
                                </span>
                                <button
                                  className="epg-refusal-dismiss"
                                  onClick={() => dismissRefusal(refusal.streamId)}
                                  title={t('ambiguousDismiss')}
                                  aria-label={t('ambiguousDismiss')}
                                  disabled={busy}
                                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                >
                                  <CrossSvg size={10} />
                                </button>
                              </div>
                              <div className="epg-refusal-choices">
                                {refusal.choices.map(choice => {
                                  const feed = sourceNameMap.get(choice.source_id) || choice.source_id;
                                  return (
                                    <button
                                      key={`${choice.source_id}:${choice.id}`}
                                      className="epg-refusal-choice"
                                      onClick={() => handleResolveRefusal(refusal, choice)}
                                      disabled={busy}
                                      title={`${feed} — ${choice.display_name}`}
                                    >
                                      <span className="epg-refusal-choice-name">
                                        {busy ? '…' : choice.display_name}
                                      </span>
                                      <span className="epg-refusal-choice-feed">{feed}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ═══ MATCHES / FEED LOCKS TAB ═══ */}
          {activeTab === 'matches' && (
            <div className="epg-matches">
              {/* Top Stats Deck */}
              <div className="epg-stats-deck">
                <div className="epg-stat-card">
                  <span className="epg-stat-val" style={{ color: 'var(--accent-primary, #00d4ff)' }}>
                    {matchVisibleCount}
                  </span>
                  <span className="epg-stat-lbl">{t('matchesMappedCount', 'Mapped Channels')}</span>
                </div>
                <div className="epg-stat-card">
                  <span className={`epg-stat-val${matchVisibleLocked > 0 ? ' epg-signal-warning' : ''}`}>
                    {matchVisibleLocked}
                  </span>
                  <span className="epg-stat-lbl">{t('matchesLocked')}</span>
                </div>
                <div className="epg-stat-card">
                  <span className={`epg-stat-val${matchVisibleElsewhere > 0 ? ' epg-signal-info' : ''}`}>
                    {matchVisibleElsewhere}
                  </span>
                  <span className="epg-stat-lbl">{t('matchesLockedElsewhere')}</span>
                </div>
              </div>

              <div className="epg-matches-toolbar">
                <input
                  className="epg-editor-input epg-matches-search"
                  value={matchFilter}
                  onChange={e => setMatchFilter(e.target.value)}
                  placeholder={t('searchPlaceholder')}
                />
                <div className="epg-matches-toggles" role="group" aria-label={t('matchesFilterLabel')}>
                  <button
                    className={`epg-matches-toggle${matchLockFilter === 'all' ? ' active' : ''}`}
                    onClick={() => setMatchLockFilter('all')}
                  >
                    {i18n.t('common:all')}
                  </button>
                  <button
                    className={`epg-matches-toggle${matchLockFilter === 'locked' ? ' active' : ''}`}
                    onClick={() => setMatchLockFilter('locked')}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                  >
                    <LockSvg size={12} />
                    <span>{t('matchesAnyLock')}</span>
                  </button>
                  <button
                    className={`epg-matches-toggle${matchLockFilter === 'elsewhere' ? ' active' : ''}`}
                    onClick={() => setMatchLockFilter('elsewhere')}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                  >
                    <SwapSvg size={12} />
                    <span>{t('matchesLockedElsewhere')}</span>
                  </button>
                </div>
                {/* A search already opens every node, so the by-hand controls would
                    be dead weight while one is active. */}
                {!matchSearchActive && (
                  <div className="epg-matches-toggles">
                    <button
                      className="epg-matches-toggle"
                      disabled={matchOpenNodeCount >= matchNodeCount}
                      onClick={() => setMatchExpanded(new Set(matchNodeKeys(matchTree)))}
                    >
                      {t('matchesExpandAll')}
                    </button>
                    <button
                      className="epg-matches-toggle"
                      disabled={matchOpenNodeCount === 0}
                      onClick={() => {
                        setMatchConfirmKey(null);
                        setMatchExpanded(new Set());
                      }}
                    >
                      {t('matchesCollapseAll')}
                    </button>
                  </div>
                )}
              </div>

              {/* The totals the tree holds rather than the library's, so the line
                  always agrees with the rows under it while a filter is on. */}
              <div className="epg-matches-summary">
                {t('matchesSummary')} <strong>{matchVisibleCount}</strong>
                <span className="epg-matches-summary-sep">·</span>
                <strong>{matchVisibleLocked}</strong> {t('matchesLocked')}
                <span className="epg-matches-summary-sep">·</span>
                <strong>{matchVisibleElsewhere}</strong> {t('matchesLockedElsewhere')}
              </div>

              {matchLoading && (
                <div className="epg-editor-empty">{i18n.t('common:loading')}</div>
              )}
              {!matchLoading && matchRows.length === 0 && (
                <div className="epg-editor-empty">{t('matchesEmpty')}</div>
              )}

              {/* One collapsible tree, walked as a flat list so only the rows on
                  screen are mounted: sources, then a source's categories, then a
                  category's channels. */}
              {!matchLoading && matchRows.length > 0 && (
                matchFlatRows.length === 0 ? (
                  <div className="epg-editor-empty">{t('noChannelsFound')}</div>
                ) : (
                  <div ref={setMatchListEl} className="epg-matches-list">
                    <VirtualList
                      key="matches-tree"
                      scrollRef={matchListRef}
                      items={matchFlatRows}
                      estimateItemHeight={52}
                      overscan={8}
                      getKey={row => row.key}
                      renderItem={row => {
                        if (row.kind === 'channel') {
                          const match = row.channel;
                          return (
                            <div className="epg-matches-row">
                              <button
                                className="epg-matches-row-main depth-2"
                                onClick={() => openChannelById(match.streamId)}
                                title={t('clickToEdit')}
                              >
                                <span className="epg-matches-row-name">{match.channelName || match.streamId}</span>
                                <span className="epg-matches-row-id">{match.epgChannelId || '—'}</span>
                                {match.matchByAlias && (
                                  <span className="epg-matches-chip">{t('matchNameAlias')}</span>
                                )}
                                {match.feedRef ? (
                                  <span
                                    className="epg-matches-chip locked"
                                    title={t('matchesLockedTo', { name: matchFeedLabel(match.feedRef) })}
                                  >
                                    <LockSvg size={11} />
                                    <span>{matchFeedLabel(match.feedRef)}</span>
                                  </span>
                                ) : (
                                  <span className="epg-matches-chip unlocked">{t('matchesNoLock')}</span>
                                )}
                              </button>
                              {match.feedRef && (
                                <button
                                  className="epg-editor-btn epg-matches-row-release"
                                  onClick={() => handleReleaseMatchRow(match.streamId)}
                                >
                                  {t('releaseFeedPin')}
                                </button>
                              )}
                            </div>
                          );
                        }

                        // A source or a category: the row opens it, and its own
                        // locked channels are one bulk release away.
                        const confirming = matchConfirmKey === row.key;
                        return (
                          <div className="epg-matches-row">
                            <button
                              className={`epg-matches-row-main is-node depth-${row.depth}${row.expanded ? ' open' : ''}`}
                              aria-expanded={row.expanded}
                              onClick={() => toggleMatchNode(row.key)}
                            >
                              <span className="epg-matches-chevron">
                                {row.expanded ? <ChevronDownSvg size={11} /> : <ChevronRightSvg size={11} />}
                              </span>
                              <span className="epg-matches-row-name">{row.label}</span>
                              <span className="epg-matches-row-count">{row.count}</span>
                              {row.locked > 0 && (
                                <span className="epg-matches-chip locked" title={t('matchesLocked')}>
                                  <LockSvg size={11} />
                                  <span>{row.locked}</span>
                                </span>
                              )}
                              {row.elsewhere > 0 && (
                                <span className="epg-matches-chip elsewhere" title={t('matchesLockedElsewhere')}>
                                  <SwapSvg size={11} />
                                  <span>{row.elsewhere}</span>
                                </span>
                              )}
                            </button>
                            {row.releaseIds.length > 0 && (
                              <button
                                className={`epg-editor-btn epg-matches-row-release${confirming ? ' epg-editor-btn-primary' : ''}`}
                                onClick={() => handleReleaseMatchNode(row.key, row.releaseIds)}
                              >
                                {confirming ? t('confirmReleaseAllFeedPins') : t('releaseAllFeedPins')}
                              </button>
                            )}
                          </div>
                        );
                      }}
                    />
                  </div>
                )
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="epg-editor-footer">
          {channelSaved && (
            <div className="epg-editor-saved-notice">
              <CheckSvg size={13} />
              <span>{t('saved')}</span>
            </div>
          )}
          <button className="epg-editor-btn epg-editor-btn-secondary" onClick={onClose}>{i18n.t('common:close')}</button>
          {activeTab === 'channel' && channel && (
            <button
              className="epg-editor-btn epg-editor-btn-primary"
              onClick={handleSaveChannel}
              disabled={channelSaving}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {channelSaving ? t('saving') : <><SaveSvg size={14} /> <span>{t('saveChannelOverride')}</span></>}
            </button>
          )}
        </div>
      </div>

      {/* Reset Confirmation Modal Overlay */}
      {showResetConfirm && channel && (
        <div className="epg-confirm-overlay" onClick={() => setShowResetConfirm(false)}>
          <div className="epg-confirm-modal" onClick={e => e.stopPropagation()}>
            <h3 className="epg-confirm-title">
              <WarningSvg size={18} style={{ color: 'var(--status-danger, #ef4444)' }} />
              <span>{t('resetChannel')}</span>
            </h3>
            <p className="epg-confirm-desc">
              {t('resetConfirm')} <strong>"{channel.name}"</strong>?
              <br/><br/>
              {t('resetConfirmDesc')}
            </p>
            <div className="epg-confirm-actions">
              <button
                className="epg-editor-btn epg-editor-btn-secondary"
                onClick={() => setShowResetConfirm(false)}
              >
                {i18n.t('common:cancel')}
              </button>
              <button
                className="epg-editor-btn epg-editor-btn-danger"
                onClick={executeResetToDefault}
              >
                {t('yesReset')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
