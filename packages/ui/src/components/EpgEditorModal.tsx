import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './EpgEditorModal.css';
import { db } from '../db';
import type { StoredChannel, StoredCategory } from '../db';
import { ChannelLogo } from './ChannelLogo';
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
  getPreviewProgramsForEpgId,
  copyProgramsFromEpgChannel,
  resetChannelToDefault,
  type EditorProgram,
  type ScoredEpgChannel,
  type EpgSearchMode,
} from '../services/epg-overrides';

// ─── Types ────────────────────────────────────────────────────────────────────

type EditorTab = 'channel' | 'programs' | 'search' | 'source' | 'automatch';
type SearchScope = 'source' | 'all';

export interface EpgEditorModalProps {
  /** If set, opens directly on a specific channel */
  channel?: StoredChannel;
  /** If set (and no channel provided), opens on the Source EPG tab */
  sourceId?: string;
  sourceName?: string;
  onClose: () => void;
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

// ─── Sub-components ───────────────────────────────────────────────────────────

/** A single program row in the Programs tab */
function ProgramRow({
  prog,
  onSave,
  onDelete,
  onRestore,
}: {
  prog: EditorProgram;
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
    <div className={`epg-program-row${prog.is_deleted ? ' is-deleted' : ''}${prog.is_custom ? ' is-custom' : ''}${editing ? ' editing' : ''}`}>
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
            <button className="epg-program-action-btn restore" onClick={onRestore}>↩ {t('undo')}</button>
          ) : (
            <>
              <button className="epg-program-action-btn" onClick={() => setEditing(true)}>✏ {i18n.t('common:edit')}</button>
              <button className="epg-program-action-btn danger" onClick={onDelete}>🗑 {i18n.t('common:delete')}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function EpgEditorModal({ channel: initialChannel, sourceId, sourceName, onClose }: EpgEditorModalProps) {
  const { t } = useTranslation('epg');
  const epgClockFormat = useEpgClockFormat();
  const overlayRef = useRef<HTMLDivElement>(null);

  // ── Navigation state ──
  const [activeTab, setActiveTab] = useState<EditorTab>(
    initialChannel ? 'channel' : sourceId ? 'source' : 'channel'
  );
  const [channel, setChannel] = useState<StoredChannel | undefined>(initialChannel);
  const resolvedSourceId = channel?.source_id ?? sourceId;

  const epgLogoDisplay = useSettingsStore((s) => s.epgLogoDisplay);
  const sourceLogoDisplayOverrides = useSettingsStore((s) => s.sourceLogoDisplayOverrides);
  const sourceDisplayOverride = channel?.source_id ? sourceLogoDisplayOverrides?.[channel.source_id] : undefined;
  const logoShape = (sourceDisplayOverride || epgLogoDisplay) as 'square' | 'rectangle';


  // ── Channel tab state ──
  const [rawChannel, setRawChannel] = useState<StoredChannel | null>(null);
  const [tvgId, setTvgId] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [logoBackground, setLogoBackground] = useState<'auto' | 'light' | 'dark'>('auto');
  const [logoPadding, setLogoPadding] = useState<'default' | 'none'>('default');
  const [epgLogoUrl, setEpgLogoUrl] = useState('');
  const [timeshiftHours, setTimeshiftHours] = useState('0');
  const [channelSaving, setChannelSaving] = useState(false);
  const [channelSaved, setChannelSaved] = useState(false);

  // ── Programs tab state ──
  const [programs, setPrograms] = useState<EditorProgram[]>([]);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSubtitle, setNewSubtitle] = useState('');
  const [newDesc, setNewDesc]   = useState('');
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd]     = useState('');

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
  const [sourceChannels, setSourceChannels] = useState<StoredChannel[]>([]);
  const [sourceFilter, setSourceFilter] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  // Track which stream_ids have overrides (for the indicator dot)
  const [overriddenIds, setOverriddenIds] = useState<Set<string>>(new Set());

  // ── Automatch tab state ──
  const [automatchSources, setAutomatchSources] = useState<{ id: string; name: string }[]>([]);
  const [automatchSourceId, setAutomatchSourceId] = useState('');
  const [automatchScope, setAutomatchScope] = useState<SearchScope>('source');
  const [automatchMode, setAutomatchMode] = useState<EpgSearchMode>('m3u');
  const [automatchThreshold, setAutomatchThreshold] = useState(40);
  const [automatchCategories, setAutomatchCategories] = useState<string[]>([]);
  const [automatchAllCategories, setAutomatchAllCategories] = useState(true);
  const [automatchRunning, setAutomatchRunning] = useState(false);
  const [automatchProgress, setAutomatchProgress] = useState<{ matched: number; total: number } | null>(null);
  const [automatchResults, setAutomatchResults] = useState<{ matched: number; skipped: number; errors: number; details: string[] } | null>(null);
  const [sourceCategories, setSourceCategories] = useState<StoredCategory[]>([]);

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
      setTvgId(ov?.epg_channel_id ?? channel.epg_channel_id ?? '');
      
      const playlistIcon = rawChan?.stream_icon ?? channel.stream_icon ?? '';
      setLogoUrl(ov?.stream_icon ?? playlistIcon);
      setLogoBackground((ov?.logo_background as 'auto' | 'light' | 'dark') ?? 'auto');
      setLogoPadding((ov?.logo_padding as 'default' | 'none') ?? 'default');
      
      setTimeshiftHours(ov?.timeshift_hours != null ? String(ov.timeshift_hours) : '0');
    }).catch(err => {
      console.error('[EPG Editor] Failed to load channel details:', err);
    });

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

  // ── Load source channels when switching to Source tab ──
  useEffect(() => {
    if (activeTab !== 'source' || !resolvedSourceId) return;
    setSourceLoading(true);
    db.channels.where('source_id').equals(resolvedSourceId).toArray().then(async chans => {
      const sorted = chans.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setSourceChannels(sorted);
      // Load overridden stream ids for dot indicators
      const overrides = await db.epgChannelOverrides.toArray();
      const ids = new Set(overrides.map(o => o.stream_id));
      setOverriddenIds(ids);
      setSourceLoading(false);
    });
  }, [activeTab, resolvedSourceId]);

  // ── Load sources for Automatch tab ──
  useEffect(() => {
    if (activeTab !== 'automatch') return;
    if (!window.storage) return;
    window.storage.getSources().then((result: any) => {
      if (result.data) {
        const sources = result.data.map((s: any) => ({ id: s.id, name: s.name }));
        setAutomatchSources(sources);
        if (!automatchSourceId && resolvedSourceId) {
          setAutomatchSourceId(resolvedSourceId);
        } else if (!automatchSourceId && sources.length > 0) {
          setAutomatchSourceId(sources[0].id);
        }
      }
    }).catch(() => {});
  }, [activeTab, resolvedSourceId]);

  // ── Load categories for Automatch tab ──
  useEffect(() => {
    if (activeTab !== 'automatch') return;
    if (!automatchSourceId || automatchScope !== 'source') {
      setSourceCategories([]);
      return;
    }
    db.categories.where('source_id').equals(automatchSourceId).toArray().then(cats => {
      const sorted = cats.sort((a, b) => (a.category_name || '').localeCompare(b.category_name || ''));
      setSourceCategories(sorted);
    });
  }, [activeTab, automatchSourceId, automatchScope]);

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
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // ── Channel tab: save ──
  async function handleSaveChannel() {
    if (!channel) return;
    setChannelSaving(true);
    try {
      const hours = parseFloat(timeshiftHours);
      await upsertChannelOverride({
        stream_id: channel.stream_id,
        epg_channel_id: tvgId.trim() || undefined,
        stream_icon: logoUrl.trim() || undefined,
        logo_background: logoBackground === 'auto' ? undefined : logoBackground,
        logo_padding: logoPadding === 'default' ? undefined : logoPadding,
        timeshift_hours: isNaN(hours) ? 0 : hours,
      });
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
  const handleAutoSuggest = useCallback(async () => {
    if (!channel) return;
    setAutoSearching(true);
    const results = await autoMatchChannelName(
      channel.name,
      searchScope === 'source' ? resolvedSourceId : undefined,
      10,
      searchMode
    );
    setSearchResults(results);
    if (results.length > 0) setSearchQuery(results[0].display_name);
    setAutoSearching(false);
  }, [channel, searchScope, searchMode, resolvedSourceId]);

  // ── Search tab: apply match ──
  async function handleApplyMatch(epgChan: ScoredEpgChannel) {
    if (!channel) return;
    setApplyingId(epgChan.id);
    try {
      const current = await getChannelOverride(channel.stream_id);
      await upsertChannelOverride({
        stream_id: channel.stream_id,
        epg_channel_id: epgChan.id,
        stream_icon: epgChan.icon_url || current?.stream_icon || channel.stream_icon,
        timeshift_hours: current?.timeshift_hours ?? 0,
      });
      setTvgId(epgChan.id);
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

  // ── Source tab: navigate to channel ──
  function handleOpenSourceChannel(ch: StoredChannel) {
    setChannel(ch);
    setActiveTab('channel');
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
    scope: SearchScope
  ): Promise<StoredChannel[]> {
    const dbInstance = await (db as any).dbPromise;

    let sql = `
      SELECT c.*
      FROM channels c
      LEFT JOIN epg_channel_overrides o ON o.stream_id = c.stream_id
      WHERE (COALESCE(o.epg_channel_id, c.epg_channel_id) IS NULL OR TRIM(COALESCE(o.epg_channel_id, c.epg_channel_id)) = '')
    `;

    const params: any[] = [];

    if (scope === 'source' && sourceId) {
      sql += ` AND c.source_id = $${params.length + 1}`;
      params.push(sourceId);
    }

    if (categoryIds.length > 0) {
      const likeClauses = categoryIds.map((_, i) => `c.category_ids LIKE $${params.length + i + 1}`).join(' OR ');
      sql += ` AND (${likeClauses})`;
      categoryIds.forEach(id => params.push(`%"${id}"%`));
    }

    sql += ` ORDER BY c.name COLLATE NOCASE`;

    const rows = await dbInstance.select(sql, params) as any[];
    return rows.map(r => ({
      ...r,
      category_ids: r.category_ids ? JSON.parse(r.category_ids) : [],
    }));
  }

  // ── Automatch tab: run auto-match for all missing channels ──
  async function handleAutoMatchMissing() {
    setAutomatchRunning(true);
    setAutomatchResults(null);
    setAutomatchProgress(null);

    try {
      const channels = await getChannelsMissingEpg(
        automatchScope === 'source' ? automatchSourceId : undefined,
        automatchAllCategories ? [] : automatchCategories,
        automatchScope
      );

      if (channels.length === 0) {
        setAutomatchResults({ matched: 0, skipped: 0, errors: 0, details: [t('noChannelsMissing')] });
        setAutomatchRunning(false);
        return;
      }

      setAutomatchProgress({ matched: 0, total: channels.length });

      let matched = 0;
      let skipped = 0;
      let errors = 0;
      const details: string[] = [];
      const threshold = automatchThreshold / 100;

      for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        try {
          const results = await autoMatchChannelName(
            ch.name,
            automatchScope === 'source' ? (automatchSourceId || undefined) : undefined,
            1,
            automatchMode
          );

          if (results.length > 0 && results[0].score >= threshold) {
            const topMatch = results[0];
            await upsertChannelOverride({
              stream_id: ch.stream_id,
              epg_channel_id: topMatch.id,
              stream_icon: topMatch.icon_url || ch.stream_icon,
              timeshift_hours: 0,
            });

            try {
              await copyProgramsFromEpgChannel(ch.stream_id, topMatch.id);
            } catch (e) {
              // Non-critical
            }

            matched++;
            details.push(`✓ ${ch.name} → ${topMatch.display_name} (${(topMatch.score * 100).toFixed(0)}%)`);
          } else {
            skipped++;
            const bestScore = results.length > 0 ? results[0].score : 0;
            details.push(`✗ ${ch.name} — best match ${(bestScore * 100).toFixed(0)}% (below ${automatchThreshold}%)`);
          }
        } catch (e) {
          errors++;
          details.push(`⚠ ${ch.name} — error`);
        }

        setAutomatchProgress({ matched: matched + skipped + errors, total: channels.length });

        // Yield to UI thread occasionally
        if (i % 3 === 0) {
          await new Promise(r => setTimeout(r, 1));
        }
      }

      setAutomatchResults({ matched, skipped, errors, details });
    } finally {
      setAutomatchRunning(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  const filteredSourceChannels = sourceChannels.filter(ch =>
    !sourceFilter || ch.name.toLowerCase().includes(sourceFilter.toLowerCase())
  );

  const tabs: { key: EditorTab; label: string }[] = channel
    ? [
        { key: 'channel',  label: `📡 ${t('channelTab')}` },
        { key: 'programs', label: `📋 ${t('programsTab')}` },
        { key: 'search',   label: `🔍 ${t('epgSearchTab')}` },
        { key: 'source',   label: `📺 ${t('allChannelsTab')}` },
        { key: 'automatch', label: `🤖 ${t('automatchTab')}` },
      ]
    : [
        { key: 'source',   label: `📺 ${t('allChannelsTab')}` },
        { key: 'search',   label: `🔍 ${t('epgSearchTab')}` },
        { key: 'automatch', label: `🤖 ${t('automatchTab')}` },
      ];

  const title = channel
    ? channel.name
    : sourceName ?? t('editorTitle');

  return createPortal(
    <div className="epg-editor-overlay" ref={overlayRef}>
      <div className="epg-editor-modal" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="epg-editor-header">
          <span style={{ fontSize: '1.2rem' }}>✏️</span>
          <div className="epg-editor-title">
            EPG Editor — <span>{title}</span>
          </div>
          <button className="epg-editor-close-btn" onClick={onClose}>✕</button>
        </div>

        {/* Tabs */}
        <div className="epg-editor-tabs">
          {tabs.map(t => (
            <button
              key={t.key}
              className={`epg-editor-tab${activeTab === t.key ? ' active' : ''}`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="epg-editor-body">

          {/* ═══ CHANNEL TAB ═══ */}
          {activeTab === 'channel' && channel && (
            <div>
              <div className="epg-editor-field">
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
              </div>

              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('logoUrlLabel')}</label>
                <div className="epg-editor-logo-row">
                  <input
                    className="epg-editor-input"
                    value={logoUrl}
                    onChange={e => setLogoUrl(e.target.value)}
                    placeholder={t('logoUrlPlaceholder')}
                  />
                  <div className="epg-editor-logo-preview-wrapper">
                    <ChannelLogo
                      src={logoUrl || undefined}
                      name={channel?.name || ''}
                      background={logoBackground}
                      padding={logoPadding}
                      shape={logoShape}
                      lazy={false}
                    />
                  </div>
                </div>
              </div>

              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('logoBackgroundLabel')}</label>
                <div className="card-segmented-control" style={{ marginTop: 4 }}>
                  <button
                    type="button"
                    className={`segmented-btn ${logoBackground === 'auto' ? 'active' : ''}`}
                    onClick={() => setLogoBackground('auto')}
                    title={t('autoBgTitle')}
                  >
                    ✨ {t('autoBg')}
                  </button>
                  <button
                    type="button"
                    className={`segmented-btn ${logoBackground === 'light' ? 'active' : ''}`}
                    onClick={() => setLogoBackground('light')}
                    title={t('lightBgTitle')}
                  >
                    ☀️ {t('lightBg')}
                  </button>
                  <button
                    type="button"
                    className={`segmented-btn ${logoBackground === 'dark' ? 'active' : ''}`}
                    onClick={() => setLogoBackground('dark')}
                    title={t('darkBgTitle')}
                  >
                    🌙 {t('darkBg')}
                  </button>
                </div>
                <div className="epg-editor-hint">
                  {t('logoBgHint')}
                </div>
              </div>

              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('logoPaddingLabel')}</label>
                <div className="card-segmented-control card-padding-control" style={{ marginTop: 4 }}>
                  <button
                    type="button"
                    className={`segmented-btn ${logoPadding === 'default' ? 'active' : ''}`}
                    onClick={() => setLogoPadding('default')}
                    title={t('normalPaddingTitle')}
                  >
                    📐 {t('normalPadding')}
                  </button>
                  <button
                    type="button"
                    className={`segmented-btn ${logoPadding === 'none' ? 'active' : ''}`}
                    onClick={() => setLogoPadding('none')}
                    title={t('noPadTitle')}
                  >
                    🖼️ {t('noPad')}
                  </button>
                </div>
                <div className="epg-editor-hint">
                  {t('logoPaddingHint')}
                </div>
              </div>

              {(() => {
                const playlistIcon = rawChannel?.stream_icon || channel.stream_icon;
                if (!playlistIcon && !epgLogoUrl) return null;
                return (
                  <div className="epg-editor-field" style={{ marginTop: -8, marginBottom: 16 }}>
                    <label className="epg-editor-label" style={{ fontSize: '0.75rem', opacity: 0.6 }}>{t('quickSelectLogo')}</label>
                    <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 4 }}>
                      {playlistIcon && (
                        <button
                          type="button"
                          onClick={() => setLogoUrl(playlistIcon)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            background: logoUrl === playlistIcon ? 'rgba(0,212,255,0.15)' : 'rgba(255,255,255,0.03)',
                            border: logoUrl === playlistIcon ? '1px solid rgba(0,212,255,0.5)' : '1px solid rgba(255,255,255,0.1)',
                            borderRadius: 6,
                            padding: '4px 8px',
                            cursor: 'pointer',
                            color: '#fff',
                            fontSize: '0.75rem',
                            outline: 'none',
                          }}
                        >
                          <img src={playlistIcon} alt="" style={{ width: 20, height: 20, objectFit: 'contain' }} />
                          <span>{t('playlistLogo')}</span>
                        </button>
                      )}
                      {epgLogoUrl && (
                        <button
                          type="button"
                          onClick={() => setLogoUrl(epgLogoUrl)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            background: logoUrl === epgLogoUrl ? 'rgba(0,212,255,0.15)' : 'rgba(255,255,255,0.03)',
                            border: logoUrl === epgLogoUrl ? '1px solid rgba(0,212,255,0.5)' : '1px solid rgba(255,255,255,0.1)',
                            borderRadius: 6,
                            padding: '4px 8px',
                            cursor: 'pointer',
                            color: '#fff',
                            fontSize: '0.75rem',
                            outline: 'none',
                          }}
                        >
                          <img src={epgLogoUrl} alt="" style={{ width: 20, height: 20, objectFit: 'contain' }} />
                          <span>{t('epgLogo')}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}

              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('timeOffsetLabel')}</label>
                <div className="epg-editor-timeshift-row">
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

              <div style={{ marginTop: 24, padding: 14, background: 'rgba(255,50,50,0.05)', border: '1px solid rgba(255,50,50,0.2)', borderRadius: 8 }}>
                <div style={{ fontSize: '0.85rem', color: '#ffaaaa', marginBottom: 8 }}>
                  <strong>{t('resetChannel')}</strong><br/>
                  {t('resetChannelDesc')}
                </div>
                <button
                  className="epg-editor-btn"
                  style={{ background: 'rgba(255,50,50,0.15)', color: '#ffaaaa', border: '1px solid rgba(255,50,50,0.3)', padding: '6px 12px' }}
                  onClick={handleResetToDefault}
                >
                  ↻ {t('resetToDefault')}
                </button>
              </div>
            </div>
          )}

          {/* ═══ PROGRAMS TAB ═══ */}
          {activeTab === 'programs' && channel && (
            <div>
              <div className="epg-editor-programs-toolbar">
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary, #888)' }}>
                  {t('showingProgramsRange')} <strong>{channel.name}</strong>
                </span>
                <button
                  className="epg-editor-btn epg-editor-btn-primary"
                  style={{ padding: '7px 14px', fontSize: '0.82rem' }}
                  onClick={() => setShowAddForm(v => !v)}
                >
                  {showAddForm ? `✕ ${i18n.t('common:cancel')}` : `+ ${t('addProgram')}`}
                </button>
              </div>

              {showAddForm && (
                <div style={{
                  padding: 14, marginBottom: 14,
                  border: '1px solid rgba(0,212,255,0.25)',
                  borderRadius: 10,
                  background: 'rgba(0,212,255,0.04)',
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
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
                    <div style={{ gridColumn: '1/-1', display: 'flex', justifyContent: 'flex-end' }}>
                      <button
                        className="epg-editor-btn epg-editor-btn-primary"
                        onClick={handleAddCustomProgram}
                        disabled={!newTitle.trim() || !newStart || !newEnd}
                      >
                        ✓ {t('addProgram')}
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
              <div className="epg-search-toolbar">
                <div className="epg-search-input-wrap">
                  <span className="epg-search-icon">🔍</span>
                  <input
                    className="epg-editor-input"
                    placeholder={t('searchPlaceholder')}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    autoFocus
                  />
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
                  >
                    {autoSearching ? '…' : `✨ ${t('autoMatch')}`}
                  </button>
                )}
              </div>

              {!channel && (
                <div style={{
                  padding: '10px 14px', borderRadius: 8, marginBottom: 12,
                  background: 'rgba(255,165,0,0.08)', border: '1px solid rgba(255,165,0,0.2)',
                  fontSize: '0.82rem', color: '#ffaa44',
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
                            <div className="epg-search-result-placeholder">📡</div>
                          )}
                          <div className="epg-search-result-info">
                            <div className="epg-search-result-name">{r.display_name}</div>
                            <div className="epg-search-result-id">{r.id}</div>
                            {searchScope === 'all' && (
                              <div className="epg-search-result-source">{t('sourceLabel2', { name: sourceNameMap.get(r.source_id) ?? r.source_id })}</div>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary, #888)', whiteSpace: 'nowrap' }}>
                              {isPreviewOpen ? `▲ ${t('hide')}` : `▼ ${t('programs')}`}
                            </span>
                            <div className="epg-score-bar" title={t('matchScore', { score: (r.score * 100).toFixed(0) })}>
                              <div className="epg-score-pip" style={{ width: `${Math.min(100, r.score / 1.2 * 100)}%` }} />
                            </div>
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
                            borderRadius: 6, overflow: 'hidden',
                            background: 'rgba(0,0,0,0.2)',
                          }}>
                            <div style={{
                              padding: '6px 14px', background: 'rgba(0,212,255,0.07)',
                              fontSize: '0.8rem', color: '#fff'
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
                                    display: 'flex', gap: 12, padding: '4px 14px',
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
                <div className="epg-editor-empty">
                  {t('typeToSearch')} <strong>✨ {t('autoMatch')}</strong> {t('toFindBestMatch')} <strong>{channel?.name ?? t('yourChannel')}</strong>.
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
                  placeholder={t('filterChannels', { source: resolvedSourceId ? `${sourceName ?? ''} ` : '' })}
                  value={sourceFilter}
                  onChange={e => setSourceFilter(e.target.value)}
                />
              </div>
              {sourceLoading ? (
                <div className="epg-editor-loading">{t('loadingChannels')}</div>
              ) : filteredSourceChannels.length === 0 ? (
                <div className="epg-editor-empty">{t('noChannelsFound')}</div>
              ) : (
                <div className="epg-source-channel-list">
                  {filteredSourceChannels.map(ch => (
                    <div
                      key={ch.stream_id}
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
                        <div style={{ width: 32, height: 32, borderRadius: 6, background: 'var(--bg-tertiary, rgba(255,255,255,0.05))', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>📡</div>
                      )}
                      <div className="epg-source-channel-name">{ch.name}</div>
                      <div className="epg-source-channel-tvgid">{ch.epg_channel_id || '—'}</div>
                      {overriddenIds.has(ch.stream_id) && (
                        <div className="epg-override-dot" title={t('hasOverrides')} />
                      )}
                      <span style={{ color: 'var(--text-secondary,#666)', fontSize: '0.85rem' }}>›</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ═══ AUTOMATCH MISSING TAB ═══ */}
          {activeTab === 'automatch' && (
            <div>
              <div style={{ marginBottom: 16, fontSize: '0.82rem', color: 'var(--text-secondary, #888)' }}>
                {t('automatchHint')}
              </div>

              {/* Source selection */}
              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('sourceLabel')}</label>
                <select
                  className="epg-editor-input"
                  value={automatchSourceId}
                  onChange={e => setAutomatchSourceId(e.target.value)}
                  disabled={automatchScope === 'all' || automatchRunning}
                  style={{ cursor: 'pointer' }}
                >
                  {automatchSources.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>

              {/* Scope toggle */}
              <div className="epg-editor-field">
                <label className="epg-editor-label">{t('scope')}</label>
                <div className="epg-search-scope-toggle">
                  <button
                    className={`epg-search-scope-btn${automatchScope === 'source' ? ' active' : ''}`}
                    onClick={() => setAutomatchScope('source')}
                    disabled={automatchRunning}
                  >{t('thisSource')}</button>
                  <button
                    className={`epg-search-scope-btn${automatchScope === 'all' ? ' active' : ''}`}
                    onClick={() => setAutomatchScope('all')}
                    disabled={automatchRunning}
                  >{t('allSources')}</button>
                </div>
              </div>

              {/* Search mode toggle */}
              <div className="epg-editor-field">
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

              {/* Category selection */}
              {automatchScope === 'source' && sourceCategories.length > 0 && (
                <div className="epg-editor-field">
                  <label className="epg-editor-label">{t('categories')}</label>
                  <div style={{ marginBottom: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-primary, #e0e0e0)' }}>
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

              {/* Threshold slider */}
              <div className="epg-editor-field">
                <label className="epg-editor-label">
                  {t('minMatchThreshold')} <strong>{automatchThreshold}%</strong>
                </label>
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

              {/* Action button */}
              <div style={{ marginTop: 20, marginBottom: 16 }}>
                <button
                  className="epg-editor-btn epg-editor-btn-primary"
                  onClick={handleAutoMatchMissing}
                  disabled={automatchRunning || (automatchScope === 'source' && !automatchSourceId) || (!automatchAllCategories && automatchCategories.length === 0)}
                  style={{ width: '100%', padding: '12px 22px', fontSize: '0.95rem' }}
                >
                  {automatchRunning && automatchProgress
                    ? t('matchingProgress', { matched: automatchProgress.matched, total: automatchProgress.total })
                    : `🤖 ${t('automatchMissingBtn')}`}
                </button>
              </div>

              {/* Progress bar */}
              {automatchRunning && automatchProgress && automatchProgress.total > 0 && (
                <div style={{ marginBottom: 20 }}>
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
                }}>
                  <div style={{
                    padding: '10px 14px',
                    background: 'rgba(255,255,255,0.03)',
                    borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.07))',
                    display: 'flex',
                    gap: 16,
                    fontSize: '0.82rem',
                  }}>
                    <span style={{ color: '#4caf50' }}><strong>{automatchResults.matched}</strong> {t('matched')}</span>
                    <span style={{ color: 'var(--text-secondary, #888)' }}><strong>{automatchResults.skipped}</strong> {t('skipped')}</span>
                    {automatchResults.errors > 0 && (
                      <span style={{ color: '#ff6b6b' }}><strong>{automatchResults.errors}</strong> {t('errors')}</span>
                    )}
                  </div>
                  <div style={{ maxHeight: 280, overflowY: 'auto', padding: '6px 0' }}>
                    {automatchResults.details.map((detail, i) => (
                      <div key={i} style={{
                        padding: '4px 14px',
                        fontSize: '0.8rem',
                        color: detail.startsWith('✓') ? '#4caf50' : detail.startsWith('⚠') ? '#ffaa44' : 'var(--text-secondary, #888)',
                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                      }}>
                        {detail}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="epg-editor-footer">
          {channelSaved && (
            <div className="epg-editor-saved-notice">✓ {t('saved')}</div>
          )}
          <button className="epg-editor-btn epg-editor-btn-secondary" onClick={onClose}>{i18n.t('common:close')}</button>
          {activeTab === 'channel' && channel && (
            <button
              className="epg-editor-btn epg-editor-btn-primary"
              onClick={handleSaveChannel}
              disabled={channelSaving}
            >
              {channelSaving ? t('saving') : `💾 ${t('saveChannelOverride')}`}
            </button>
          )}
        </div>
      </div>

      {/* Reset Confirmation Modal Overlay */}
      {showResetConfirm && channel && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 100, borderRadius: 16
        }}>
          <div style={{
            background: 'var(--bg-elevated, #1a1a1a)',
            border: '1px solid rgba(255,50,50,0.3)',
            padding: 24, borderRadius: 12, maxWidth: 360, width: '100%',
            boxShadow: '0 8px 32px rgba(0,0,0,0.8)'
          }}>
            <h3 style={{ margin: '0 0 12px 0', color: '#ff5555', fontSize: '1.2rem' }}>⚠ {t('resetChannel')}</h3>
            <p style={{ margin: '0 0 24px 0', fontSize: '0.9rem', color: '#ccc', lineHeight: 1.5 }}>
              {t('resetConfirm')} <strong>"{channel.name}"</strong>?
              <br/><br/>
              {t('resetConfirmDesc')}
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                className="epg-editor-btn"
                style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: 'none', padding: '8px 16px' }}
                onClick={() => setShowResetConfirm(false)}
              >
                {i18n.t('common:cancel')}
              </button>
              <button
                className="epg-editor-btn"
                style={{ background: 'rgba(255,50,50,0.15)', color: '#ffaaaa', border: '1px solid rgba(255,50,50,0.4)', padding: '8px 16px' }}
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
