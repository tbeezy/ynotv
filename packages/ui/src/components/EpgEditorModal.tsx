import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './EpgEditorModal.css';
import { db } from '../db';
import type { StoredChannel } from '../db';
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
} from '../services/epg-overrides';

// ─── Types ────────────────────────────────────────────────────────────────────

type EditorTab = 'channel' | 'programs' | 'search' | 'source';
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

function formatShortDatetime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
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
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(prog.title);
  const [desc, setDesc] = useState(prog.description);
  const [start, setStart] = useState(formatDatetimeLocal(prog.start));
  const [end, setEnd] = useState(formatDatetimeLocal(prog.end));

  // Reset edit fields when prog changes externally
  useEffect(() => {
    setTitle(prog.title);
    setDesc(prog.description);
    setStart(formatDatetimeLocal(prog.start));
    setEnd(formatDatetimeLocal(prog.end));
    setEditing(false);
  }, [prog.id]);

  function handleSave() {
    onSave({
      title,
      description: desc,
      start: datetimeLocalToIso(start),
      end: datetimeLocalToIso(end),
    });
    setEditing(false);
  }

  return (
    <div className={`epg-program-row${prog.is_deleted ? ' is-deleted' : ''}${prog.is_custom ? ' is-custom' : ''}${editing ? ' editing' : ''}`}>
      <div className="epg-program-time">
        <div>{formatShortDatetime(prog.start)}</div>
        <div style={{ opacity: 0.6, fontSize: '0.7rem', marginTop: 2 }}>→ {formatShortDatetime(prog.end)}</div>
      </div>
      <div className="epg-program-info">
        <div className="epg-program-title">{prog.title || '(No title)'}</div>
        <div className="epg-program-badges">
          {prog.has_override && !prog.is_deleted && !prog.is_custom && (
            <span className="epg-badge epg-badge-modified">Modified</span>
          )}
          {prog.is_custom && <span className="epg-badge epg-badge-custom">Custom</span>}
          {prog.is_deleted && <span className="epg-badge epg-badge-deleted">Deleted</span>}
        </div>
        {editing && (
          <div className="epg-program-edit-form">
            <div className="full-width">
              <input
                className="epg-editor-input"
                placeholder="Title"
                value={title}
                onChange={e => setTitle(e.target.value)}
              />
            </div>
            <div className="full-width">
              <textarea
                className="epg-editor-textarea"
                placeholder="Description (optional)"
                value={desc}
                rows={2}
                onChange={e => setDesc(e.target.value)}
              />
            </div>
            <div>
              <label className="epg-editor-label">Start</label>
              <input
                type="datetime-local"
                className="epg-editor-input"
                value={start}
                onChange={e => setStart(e.target.value)}
              />
            </div>
            <div>
              <label className="epg-editor-label">End</label>
              <input
                type="datetime-local"
                className="epg-editor-input"
                value={end}
                onChange={e => setEnd(e.target.value)}
              />
            </div>
            <div className="full-width" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="epg-editor-btn epg-editor-btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
              <button className="epg-editor-btn epg-editor-btn-primary" onClick={handleSave}>Save Program</button>
            </div>
          </div>
        )}
      </div>
      {!editing && (
        <div className="epg-program-actions">
          {prog.is_deleted ? (
            <button className="epg-program-action-btn restore" onClick={onRestore}>↩ Undo</button>
          ) : (
            <>
              <button className="epg-program-action-btn" onClick={() => setEditing(true)}>✏ Edit</button>
              <button className="epg-program-action-btn danger" onClick={onDelete}>🗑 Delete</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function EpgEditorModal({ channel: initialChannel, sourceId, sourceName, onClose }: EpgEditorModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // ── Navigation state ──
  const [activeTab, setActiveTab] = useState<EditorTab>(
    initialChannel ? 'channel' : sourceId ? 'source' : 'channel'
  );
  const [channel, setChannel] = useState<StoredChannel | undefined>(initialChannel);
  const resolvedSourceId = channel?.source_id ?? sourceId;

  // ── Channel tab state ──
  const [tvgId, setTvgId] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [timeshiftHours, setTimeshiftHours] = useState('0');
  const [channelSaving, setChannelSaving] = useState(false);
  const [channelSaved, setChannelSaved] = useState(false);

  // ── Programs tab state ──
  const [programs, setPrograms] = useState<EditorProgram[]>([]);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc]   = useState('');
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd]     = useState('');

  // ── Search tab state ──
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<SearchScope>('source');
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
    getPreviewProgramsForEpgId(previewResult.id)
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
    window.storage.getSources().then((result: any) => {
      if (result.data) {
        const map = new Map<string, string>();
        for (const s of result.data) map.set(s.id, s.name);
        setSourceNameMap(map);
      }
    }).catch(() => {});
  }, []);

  // ── Source tab state ──
  const [sourceChannels, setSourceChannels] = useState<StoredChannel[]>([]);
  const [sourceFilter, setSourceFilter] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  // Track which stream_ids have overrides (for the indicator dot)
  const [overriddenIds, setOverriddenIds] = useState<Set<string>>(new Set());

  // ── Load channel override when channel changes ──
  useEffect(() => {
    if (!channel) return;
    getChannelOverride(channel.stream_id).then(ov => {
      setTvgId(ov?.epg_channel_id ?? channel.epg_channel_id ?? '');
      setLogoUrl(ov?.stream_icon ?? channel.stream_icon ?? '');
      setTimeshiftHours(ov?.timeshift_hours != null ? String(ov.timeshift_hours) : '0');
    });
  }, [channel]);

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

  // ── Debounced search ──
  useEffect(() => {
    if (activeTab !== 'search') return;
    if (!searchQuery.trim()) { setSearchResults([]); return; }

    const tid = setTimeout(async () => {
      setSearchLoading(true);
      const results = await searchEpgChannels(
        searchQuery,
        searchScope === 'source' ? resolvedSourceId : undefined
      );
      setSearchResults(results);
      setSearchLoading(false);
    }, 300);

    return () => clearTimeout(tid);
  }, [searchQuery, searchScope, activeTab, resolvedSourceId]);

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
      description: newDesc.trim(),
      start: startIso,
      end: endIso,
      is_deleted: 0,
      is_custom: 1,
    });
    const newProg: EditorProgram = {
      id, stream_id: channel.stream_id,
      title: newTitle.trim(), description: newDesc.trim(),
      start: startIso, end: endIso,
      source_id: '', has_override: true,
      is_deleted: false, is_custom: true,
    };
    setPrograms(prev => [...prev, newProg].sort((a, b) => a.start.localeCompare(b.start)));
    setNewTitle(''); setNewDesc(''); setNewStart(''); setNewEnd('');
    setShowAddForm(false);
  }

  // ── Search tab: auto-suggest ──
  const handleAutoSuggest = useCallback(async () => {
    if (!channel) return;
    setAutoSearching(true);
    const results = await autoMatchChannelName(
      channel.name,
      searchScope === 'source' ? resolvedSourceId : undefined
    );
    setSearchResults(results);
    if (results.length > 0) setSearchQuery(results[0].display_name);
    setAutoSearching(false);
  }, [channel, searchScope, resolvedSourceId]);

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
        await copyProgramsFromEpgChannel(channel.stream_id, epgChan.id);
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

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  const filteredSourceChannels = sourceChannels.filter(ch =>
    !sourceFilter || ch.name.toLowerCase().includes(sourceFilter.toLowerCase())
  );

  const tabs: { key: EditorTab; label: string }[] = channel
    ? [
        { key: 'channel',  label: '📡 Channel' },
        { key: 'programs', label: '📋 Programs' },
        { key: 'search',   label: '🔍 EPG Search' },
        { key: 'source',   label: '📺 All Channels' },
      ]
    : [
        { key: 'source',   label: '📺 All Channels' },
        { key: 'search',   label: '🔍 EPG Search' },
      ];

  const title = channel
    ? channel.name
    : sourceName ?? 'EPG Editor';

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
                <label className="epg-editor-label">TVG-ID (EPG Channel ID)</label>
                <input
                  className="epg-editor-input"
                  value={tvgId}
                  onChange={e => setTvgId(e.target.value)}
                  placeholder="e.g. BBC.One.uk"
                />
                <div className="epg-editor-hint">
                  The ID used to match this channel to EPG data. Use the EPG Search tab to find the right ID.
                </div>
              </div>

              <div className="epg-editor-field">
                <label className="epg-editor-label">Logo URL (Override)</label>
                <div className="epg-editor-logo-row">
                  <input
                    className="epg-editor-input"
                    value={logoUrl}
                    onChange={e => setLogoUrl(e.target.value)}
                    placeholder="https://..."
                  />
                  {logoUrl ? (
                    <img
                      key={logoUrl}
                      src={logoUrl}
                      alt="logo"
                      className="epg-editor-logo-preview"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div className="epg-editor-logo-placeholder">📺</div>
                  )}
                </div>
              </div>

              <div className="epg-editor-field">
                <label className="epg-editor-label">EPG Time Offset (hours)</label>
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
                    Shifts all EPG times for this channel by this many hours (use negative to shift back)
                  </span>
                </div>
              </div>

              <div style={{ marginTop: 24, padding: 14, background: 'rgba(255,50,50,0.05)', border: '1px solid rgba(255,50,50,0.2)', borderRadius: 8 }}>
                <div style={{ fontSize: '0.85rem', color: '#ffaaaa', marginBottom: 8 }}>
                  <strong>Reset Channel</strong><br/>
                  Clear all manual edits, custom programs, and logo overrides for this channel.
                </div>
                <button
                  className="epg-editor-btn"
                  style={{ background: 'rgba(255,50,50,0.15)', color: '#ffaaaa', border: '1px solid rgba(255,50,50,0.3)', padding: '6px 12px' }}
                  onClick={handleResetToDefault}
                >
                  ↻ Reset to Default
                </button>
              </div>
            </div>
          )}

          {/* ═══ PROGRAMS TAB ═══ */}
          {activeTab === 'programs' && channel && (
            <div>
              <div className="epg-editor-programs-toolbar">
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary, #888)' }}>
                  Showing ±3 days of programs for <strong>{channel.name}</strong>
                </span>
                <button
                  className="epg-editor-btn epg-editor-btn-primary"
                  style={{ padding: '7px 14px', fontSize: '0.82rem' }}
                  onClick={() => setShowAddForm(v => !v)}
                >
                  {showAddForm ? '✕ Cancel' : '+ Add Program'}
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
                      <label className="epg-editor-label">Title *</label>
                      <input className="epg-editor-input" value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Program title" />
                    </div>
                    <div style={{ gridColumn: '1/-1' }}>
                      <label className="epg-editor-label">Description</label>
                      <textarea className="epg-editor-textarea" value={newDesc} rows={2} onChange={e => setNewDesc(e.target.value)} placeholder="Optional description" />
                    </div>
                    <div>
                      <label className="epg-editor-label">Start *</label>
                      <input type="datetime-local" className="epg-editor-input" value={newStart} onChange={e => setNewStart(e.target.value)} />
                    </div>
                    <div>
                      <label className="epg-editor-label">End *</label>
                      <input type="datetime-local" className="epg-editor-input" value={newEnd} onChange={e => setNewEnd(e.target.value)} />
                    </div>
                    <div style={{ gridColumn: '1/-1', display: 'flex', justifyContent: 'flex-end' }}>
                      <button
                        className="epg-editor-btn epg-editor-btn-primary"
                        onClick={handleAddCustomProgram}
                        disabled={!newTitle.trim() || !newStart || !newEnd}
                      >
                        ✓ Add Program
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {programsLoading ? (
                <div className="epg-editor-loading">Loading programs…</div>
              ) : programs.length === 0 ? (
                <div className="epg-editor-empty">
                  No programs found for this channel in the ±3 day window.<br />
                  <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>Sync your source to populate EPG data, or add a custom program above.</span>
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
                Search your synced EPG channel list to find the right TVG-ID, then click <strong>Apply</strong> to link it to{' '}
                <strong>{channel?.name ?? 'the selected channel'}</strong>.
              </div>
              <div className="epg-search-toolbar">
                <div className="epg-search-input-wrap">
                  <span className="epg-search-icon">🔍</span>
                  <input
                    className="epg-editor-input"
                    placeholder="Search EPG channels…"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="epg-search-scope-toggle">
                  <button
                    className={`epg-search-scope-btn${searchScope === 'source' ? ' active' : ''}`}
                    onClick={() => setSearchScope('source')}
                  >This Source</button>
                  <button
                    className={`epg-search-scope-btn${searchScope === 'all' ? ' active' : ''}`}
                    onClick={() => setSearchScope('all')}
                  >All Sources</button>
                </div>
                {channel && (
                  <button
                    className="epg-search-auto-btn"
                    onClick={handleAutoSuggest}
                    disabled={autoSearching}
                    title="Score all EPG channels against this channel's name"
                  >
                    {autoSearching ? '…' : '✨ Auto-match'}
                  </button>
                )}
              </div>

              {!channel && (
                <div style={{
                  padding: '10px 14px', borderRadius: 8, marginBottom: 12,
                  background: 'rgba(255,165,0,0.08)', border: '1px solid rgba(255,165,0,0.2)',
                  fontSize: '0.82rem', color: '#ffaa44',
                }}>
                  Open a channel from the All Channels tab first to use Apply.
                </div>
              )}

              {searchLoading && <div className="epg-editor-loading">Searching…</div>}

              {!searchLoading && searchQuery && searchResults.length === 0 && (
                <div className="epg-editor-empty">No EPG channels matched "{searchQuery}"</div>
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
                              <div className="epg-search-result-source">Source: {sourceNameMap.get(r.source_id) ?? r.source_id}</div>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary, #888)', whiteSpace: 'nowrap' }}>
                              {isPreviewOpen ? '▲ Hide' : '▼ Programs'}
                            </span>
                            <div className="epg-score-bar" title={`Match score: ${(r.score * 100).toFixed(0)}%`}>
                              <div className="epg-score-pip" style={{ width: `${Math.min(100, r.score / 1.2 * 100)}%` }} />
                            </div>
                            {channel && (
                              <button
                                className="epg-search-apply-btn"
                                disabled={applyingId === r.id}
                                onClick={e => { e.stopPropagation(); handleApplyMatch(r); }}
                              >
                                {applyingId === r.id ? '…' : 'Apply'}
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
                              Programs for <strong>{r.display_name}</strong>
                            </div>
                            {previewLoading ? (
                              <div className="epg-editor-loading" style={{ margin: '10px 0' }}>Loading programs…</div>
                            ) : previewPrograms.length === 0 ? (
                              <div className="epg-editor-empty" style={{ padding: '12px 14px' }}>
                                No programs found. This EPG channel may not have data synced yet.
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
                                      {formatShortDatetime(p.start)}
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
                  Type to search or click <strong>✨ Auto-match</strong> to find the best match for <strong>{channel?.name ?? 'your channel'}</strong>.
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
                  placeholder={`Filter ${resolvedSourceId ? `${sourceName ?? ''} ` : ''}channels…`}
                  value={sourceFilter}
                  onChange={e => setSourceFilter(e.target.value)}
                />
              </div>
              {sourceLoading ? (
                <div className="epg-editor-loading">Loading channels…</div>
              ) : filteredSourceChannels.length === 0 ? (
                <div className="epg-editor-empty">No channels found.</div>
              ) : (
                <div className="epg-source-channel-list">
                  {filteredSourceChannels.map(ch => (
                    <div
                      key={ch.stream_id}
                      className="epg-source-channel-row"
                      onClick={() => handleOpenSourceChannel(ch)}
                      title="Click to edit EPG for this channel"
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
                        <div className="epg-override-dot" title="Has EPG overrides" />
                      )}
                      <span style={{ color: 'var(--text-secondary,#666)', fontSize: '0.85rem' }}>›</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="epg-editor-footer">
          {channelSaved && (
            <div className="epg-editor-saved-notice">✓ Saved</div>
          )}
          <button className="epg-editor-btn epg-editor-btn-secondary" onClick={onClose}>Close</button>
          {activeTab === 'channel' && channel && (
            <button
              className="epg-editor-btn epg-editor-btn-primary"
              onClick={handleSaveChannel}
              disabled={channelSaving}
            >
              {channelSaving ? 'Saving…' : '💾 Save Channel Override'}
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
            <h3 style={{ margin: '0 0 12px 0', color: '#ff5555', fontSize: '1.2rem' }}>⚠ Reset Channel</h3>
            <p style={{ margin: '0 0 24px 0', fontSize: '0.9rem', color: '#ccc', lineHeight: 1.5 }}>
              Are you sure you want to reset <strong>"{channel.name}"</strong>?
              <br/><br/>
              This will permanently clear all EPG overrides, custom logos, and manually added programs, restoring the original data from your provider.
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                className="epg-editor-btn"
                style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: 'none', padding: '8px 16px' }}
                onClick={() => setShowResetConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="epg-editor-btn"
                style={{ background: 'rgba(255,50,50,0.15)', color: '#ffaaaa', border: '1px solid rgba(255,50,50,0.4)', padding: '8px 16px' }}
                onClick={executeResetToDefault}
              >
                Yes, Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
