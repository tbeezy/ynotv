import { useState, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Source } from '@ynotv/core';
import { syncAllSources, syncAllVod, syncSource, syncVodForSource, markSourceDeleted, type SyncResult, type VodSyncResult } from '../../db/sync';
import { clearSourceData, clearVodData, db } from '../../db';
import { useSyncStatus } from '../../hooks/useChannels';
import {
  useChannelSyncing,
  useSetChannelSyncing,
  useVodSyncing,
  useSetVodSyncing,
  useSyncStatusMessage,
  useSetSyncStatusMessage
} from '../../stores/uiStore';
import { parseM3U } from '@ynotv/local-adapter';
import { CategoryManager } from './CategoryManager';
import './SourcesTab.css';
import { useSourceVersion } from '../../contexts/SourceVersionContext';

interface SourcesTabProps {
  sources: Source[];
  isEncryptionAvailable: boolean;
  onSourcesChange: () => void;
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
  epgUrl: string;
  userAgent: string;
  epgTimeshiftHours: number;
  backupMacs: string[];
  backupCredentials: Array<{ username: string; password: string }>;
  pendingSwap: boolean;
  display_order?: number;
}

const emptyForm: SourceFormData = {
  name: '',
  type: 'm3u',
  url: '',
  username: '',
  password: '',
  mac: '',
  autoLoadEpg: true,
  epgUrl: '',
  userAgent: '',
  epgTimeshiftHours: 0,
  backupMacs: [],
  backupCredentials: [],
  pendingSwap: false,
  display_order: undefined,
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

// Format time difference in human-readable format
function formatTimeAgo(date: Date | null | undefined): string {
  if (!date) return 'Never synced';

  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  const weeks = Math.floor(diffDays / 7);
  return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
}

export function SourcesTab({ sources, isEncryptionAvailable, onSourcesChange }: SourcesTabProps) {
  const { incrementVersion } = useSourceVersion(); // Get version incrementer
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<SourceFormData>(emptyForm);
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

  // State for inline backup inputs
  const [newBackupMac, setNewBackupMac] = useState('');
  const [showBackupMacInput, setShowBackupMacInput] = useState(false);
  const [newBackupUser, setNewBackupUser] = useState('');
  const [newBackupPass, setNewBackupPass] = useState('');
  const [showBackupCredInput, setShowBackupCredInput] = useState(false);

  // Password visibility state
  const [showPassword, setShowPassword] = useState(false);
  const [showBackupPassword, setShowBackupPassword] = useState(false);

  // Category manager modal state
  const [categoryManagerSource, setCategoryManagerSource] = useState<{ id: string; name: string } | null>(null);

  // Delete confirmation modal state
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);

  const hasVodSource = sources.some(s => s.type === 'xtream' || s.type === 'stalker');

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
    setFormData({
      name: source.name,
      type: source.type as SourceType, // Use the actual type directly
      url: source.url,
      username: source.username || '',
      password: source.password || '',
      mac: source.mac || '',
      autoLoadEpg: source.auto_load_epg ?? (source.type === 'xtream'),
      epgUrl: source.epg_url || '',
      userAgent: source.user_agent || '',
      epgTimeshiftHours: source.epg_timeshift_hours || 0,
      backupMacs: source.backup_macs || [],
      backupCredentials: source.backup_credentials || [],
      pendingSwap: false,
      display_order: source.display_order,
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

    // Validation
    if (!formData.name.trim()) {
      setError('Name is required');
      return;
    }
    // URL is required unless this is a file import
    if (!importedM3U && !formData.url.trim()) {
      setError('URL is required');
      return;
    }
    if (formData.type === 'xtream' && (!formData.username.trim() || !formData.password.trim())) {
      setError('Username and password are required for Xtream');
      return;
    }
    if (formData.type === 'stalker' && !formData.mac.trim()) {
      setError('MAC Address is required for Stalker Portal');
      return;
    }

    const sourceId = editingId || crypto.randomUUID();

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
      epg_url: formData.epgUrl.trim() || undefined,
      user_agent: formData.userAgent.trim() || undefined,
      epg_timeshift_hours: formData.epgTimeshiftHours || undefined,
      backup_macs: formData.type === 'stalker' && formData.backupMacs.length > 0 ? formData.backupMacs : undefined,
      backup_credentials: formData.type === 'xtream' && formData.backupCredentials.length > 0 ? formData.backupCredentials : undefined,
      display_order: formData.display_order,
    };

    console.log('[SourcesTab] Saving source with UA:', source.user_agent);

    // If swap occurred, trigger resync after save
    const needsResync = formData.pendingSwap;

    const result = await window.storage.saveSource(source);
    if (result.error) {
      setError(result.error);
      return;
    }

    // For file imports, store channels directly in the database
    if (importedM3U) {
      const parsed = parseM3U(importedM3U.rawContent, sourceId);

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
        });
      });
    }

    setShowAddForm(false);
    setFormData(emptyForm);
    setEditingId(null);
    setImportedM3U(null);
    onSourcesChange();
    incrementVersion(); // Notify listeners of new source

    // Trigger auto-resync if swap occurred
    if (needsResync) {
      console.log('[SourcesTab] Triggering auto-resync due to credential swap');
      // Pass the updated source object directly to avoid race conditions
      setTimeout(() => handleSourceSync(sourceId, source), 100);
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
    if (confirm('Are you sure you want to delete this backup credential?')) {
      if (type === 'stalker') {
        const newBackups = formData.backupMacs.filter((_, i) => i !== index);
        setFormData({ ...formData, backupMacs: newBackups });
      } else {
        const newBackups = formData.backupCredentials.filter((_, i) => i !== index);
        setFormData({ ...formData, backupCredentials: newBackups });
      }
    }
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
    setSyncStatusMsg('Initializing...');
    try {
      const results = await syncAllSources(setSyncStatusMsg);
      setSyncResults(results);
      // Trigger category refresh after sync completes
      incrementVersion();
    } catch (err) {
      console.error('Sync error:', err);
      setSyncError(err instanceof Error ? err.message : 'Channel sync failed');
    } finally {
      setSyncing(false);
      setSyncStatusMsg(null);
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
      console.error('VOD sync error:', err);
      setSyncError(err instanceof Error ? err.message : 'VOD sync failed');
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

    setSyncingSourceId(sourceId);
    setSyncStatusMsg('Starting...');
    try {
      const result = await syncSource(source, setSyncStatusMsg);
      // Show success/failure notification
      if (result.success) {
        console.log(`Source ${source.name}: ${result.channelCount} channels synced`);
      } else {
        console.error(`Source ${source.name} sync failed:`, result.error);
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
    if (!source || (source.type !== 'xtream' && source.type !== 'stalker')) return;

    setVodSyncingSourceId(sourceId);
    try {
      const result = await syncVodForSource(source);
      if (result.success) {
        console.log(`Source ${source.name}: ${result.movieCount} movies, ${result.seriesCount} series synced`);
      } else {
        console.error(`Source ${source.name} VOD sync failed:`, result.error);
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

  // --- Drag and Drop Handlers ---

  const getIndexFromClientY = (clientY: number): number => {
    if (!listRef.current) return 0;
    const children = Array.from(listRef.current.children) as HTMLElement[];
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return Math.max(0, children.length - 1);
  };

  const handleHandlePointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return; // Only left click
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragFromIdx.current = index;
    setDragOverIdx(index);
  };

  const handleContainerPointerMove = (e: React.PointerEvent) => {
    if (dragFromIdx.current === null) return;
    e.preventDefault();
    setDragOverIdx(getIndexFromClientY(e.clientY));
  };

  const handleContainerPointerUp = async (e: React.PointerEvent) => {
    if (dragFromIdx.current === null) return;
    const from = dragFromIdx.current;
    const to = getIndexFromClientY(e.clientY);

    dragFromIdx.current = null;
    setDragOverIdx(null);

    if (from === to) return;

    // Execute reorder
    const newSources = [...sortedSources];
    const [moved] = newSources.splice(from, 1);
    newSources.splice(to, 0, moved);

    if (!window.storage) return;

    // Fast optimistic UI update could go here if we had local state for sources,
    // but we use the props passed down from Settings.tsx.
    // Instead, we just sequentially save them.
    for (let i = 0; i < newSources.length; i++) {
      const sourceToSave = newSources[i];
      // Only execute DB write if the physical order actually changed to prevent 
      // pointless SQLite write saturation
      if (sourceToSave.display_order !== i) {
        await window.storage.saveSource({ ...sourceToSave, display_order: i });
      }
    }

    // Refresh immediately
    onSourcesChange();
    incrementVersion(); // Tell downstream components (like CategoryStrip) that the source array order changed
  };

  const handleContainerPointerCancel = () => {
    dragFromIdx.current = null;
    setDragOverIdx(null);
  };


  return (
    <div className="settings-tab-content">
      {/* Sources List */}
      <div className="settings-section">
        <div className="section-header">
          <h3>Sources</h3>
          <div className="section-actions">
            <button
              className="sync-btn"
              onClick={handleSync}
              disabled={syncing || sources.length === 0}
              style={{ minWidth: '140px' }}
            >
              {syncing ? (syncStatusMsg || 'Syncing...') : 'Sync Channels'}
            </button>
            <button
              className="sync-btn"
              onClick={handleVodSync}
              disabled={vodSyncing || !hasVodSource}
            >
              {vodSyncing ? 'Syncing...' : 'Sync Movies & Series'}
            </button>
            <button className="add-btn" onClick={handleAdd}>+ Add Source</button>
          </div>
        </div>

        {syncError && (
          <div className="sync-error">{syncError}</div>
        )}

        {sources.length === 0 ? (
          <div className="empty-state">
            <p>No sources configured</p>
            <p className="hint">Add an M3U playlist or Xtream account to get started</p>
          </div>
        ) : (
          <ul
            className="sources-list sortable-list"
            ref={listRef}
            onPointerMove={handleContainerPointerMove}
            onPointerUp={handleContainerPointerUp}
            onPointerCancel={handleContainerPointerCancel}
          >
            {sortedSources.map((source, index) => {
              const meta = syncStatus.find(s => s.source_id === source.id);
              const isDragging = dragFromIdx.current === index;
              const isDragOver = dragOverIdx === index && dragFromIdx.current !== null && dragFromIdx.current !== index;

              return (
                <li
                  key={source.id}
                  className={`source-item${isDragging ? ' dragging' : ''}${isDragOver ? ' drag-over' : ''}`}
                >
                  <span
                    className="drag-handle"
                    style={{ touchAction: 'none' }}
                    onPointerDown={e => handleHandlePointerDown(e, index)}
                    title="Drag to reorder"
                  >
                    ⋮⋮
                  </span>
                  <div className="source-info">
                    <div className="source-header">
                      <div className="source-name-type">
                        <span className="source-name">{source.name}</span>
                        <span className="source-type">{source.type.toUpperCase()}</span>
                        <label className="source-toggle">
                          <input
                            type="checkbox"
                            checked={source.enabled !== false}
                            onChange={() => handleToggleEnabled(source.id)}
                            title={source.enabled !== false ? 'Enabled' : 'Disabled'}
                          />
                          <span className="toggle-label">
                            {source.enabled !== false ? 'Enabled' : 'Disabled'}
                          </span>
                        </label>
                      </div>
                      {/* Last Sync Time - compact in corner */}
                      <span className="last-sync-time">
                        {formatTimeAgo(meta?.last_synced ? new Date(meta.last_synced) : null)}
                      </span>
                    </div>

                    <div className="source-details">
                      {/* Channel/Movie counts inline */}
                      {meta && (
                        <>
                          {meta.channel_count > 0 && (
                            <span className="stat-item">
                              📡 {meta.channel_count} channels
                            </span>
                          )}
                          {((meta.vod_movie_count ?? 0) + (meta.vod_series_count ?? 0)) > 0 && (
                            <span className="stat-item">
                              🎬 {meta.vod_movie_count ?? 0} movies, {meta.vod_series_count ?? 0} series
                            </span>
                          )}
                        </>
                      )}

                      {/* Connection stats for Xtream */}
                      {source.type === 'xtream' && meta && meta.active_cons && meta.max_connections && (
                        <div className="source-connections">
                          🔗 {meta.active_cons}/{meta.max_connections}
                        </div>
                      )}

                      {/* Expiry date on separate row */}
                      {meta && meta.expiry_date && (
                        <div className="source-expiry">
                          ⏰ Exp: {formatExpiryDate(meta.expiry_date)}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="source-actions">
                    {/* Per-source sync buttons */}
                    <button
                      className="sync-source-btn"
                      onClick={() => handleSourceSync(source.id)}
                      disabled={syncingSourceId === source.id || !source.enabled}
                      title="Sync channels for this source only"
                      style={{
                        padding: '4px 8px',
                        fontSize: '0.65rem',
                        ...(syncingSourceId === source.id ? { width: 'auto' } : {})
                      }}
                    >
                      {syncingSourceId === source.id ? (syncStatusMsg || '⟳') : ''} {syncingSourceId === source.id ? '' : 'Sync Channels'}
                    </button>

                    {(source.type === 'xtream' || source.type === 'stalker') && (
                      <button
                        className="sync-source-btn"
                        onClick={() => handleSourceVodSync(source.id)}
                        disabled={vodSyncingSourceId === source.id || !source.enabled}
                        title="Sync movies & series for this source only"
                        style={{ padding: '4px 8px', fontSize: '0.65rem' }}
                      >
                        {vodSyncingSourceId === source.id ? '⟳' : ''} Sync VOD
                      </button>
                    )}

                    <button
                      className="sync-source-btn"
                      onClick={() => setCategoryManagerSource({ id: source.id, name: source.name })}
                      title="Manage categories for this source"
                      style={{ padding: '4px 8px', fontSize: '0.65rem' }}
                    >
                      Categories
                    </button>

                    <button
                      className="action-icon-btn"
                      onClick={() => handleEdit(source)}
                      title="Edit Source"
                      style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                    >
                      ⚙️
                    </button>
                    <button
                      className="action-icon-btn delete"
                      onClick={() => handleDeleteClick(source.id, source.name)}
                      disabled={isDeleting}
                      title="Delete Source"
                      style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                    >
                      {isDeleting ? '⏳' : '🗑️'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Add/Edit Form */}
      {showAddForm && createPortal(
        <div className="source-form-overlay">
          <form className="source-form" onSubmit={handleSubmit}>
            <h3>{editingId ? 'Edit Source' : 'Add Source'}</h3>

            {error && <div className="form-error">{error}</div>}

            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="My IPTV Provider"
              />
            </div>

            {/* Type selector - hidden for file imports */}
            {!importedM3U && (
              <div className="form-group">
                <label>Type</label>
                <div className="type-selector">
                  <button
                    type="button"
                    className={formData.type === 'm3u' ? 'active' : ''}
                    onClick={() => setFormData({ ...formData, type: 'm3u' })}
                  >
                    M3U Playlist
                  </button>
                  <button
                    type="button"
                    className={formData.type === 'xtream' ? 'active' : ''}
                    onClick={() => setFormData({ ...formData, type: 'xtream' })}
                  >
                    Xtream Codes
                  </button>
                  <button
                    type="button"
                    className={formData.type === 'stalker' ? 'active' : ''}
                    onClick={() => setFormData({ ...formData, type: 'stalker' })}
                  >
                    Stalker Portal
                  </button>
                </div>
              </div>
            )}

            {/* URL field for Xtream/Stalker sources */}
            {(formData.type === 'xtream' || formData.type === 'stalker') && (
              <div className="form-group">
                <label>Host URL</label>
                <input
                  type="text"
                  value={formData.url}
                  onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                  placeholder="http://provider.com:8080"
                />
              </div>
            )}

            {/* M3U: URL or File import */}
            {formData.type === 'm3u' && !importedM3U && (
              <div className="form-group">
                <label>Playlist URL</label>
                <input
                  type="text"
                  value={formData.url}
                  onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                  placeholder="http://example.com/playlist.m3u"
                />
                <div className="or-divider">
                  <span>or</span>
                </div>
                <button
                  type="button"
                  className="import-btn"
                  onClick={handleImportM3U}
                >
                  Import from File...
                </button>
              </div>
            )}

            {/* Import info for file imports */}
            {formData.type === 'm3u' && importedM3U && (
              <div className="form-group import-info">
                <label>Imported File</label>
                <div className="import-summary">
                  <span>{importedM3U.channels} channels</span>
                  <span>{importedM3U.categories} categories</span>
                  {importedM3U.epgUrl && <span>EPG URL detected</span>}
                </div>
                <button
                  type="button"
                  className="change-file-btn"
                  onClick={() => setImportedM3U(null)}
                >
                  Use URL instead
                </button>
              </div>
            )}

            {formData.type === 'stalker' && (
              <>
                <div className="form-group">
                  <label>MAC Address</label>
                  <input
                    type="text"
                    value={formData.mac}
                    onChange={(e) => setFormData({ ...formData, mac: e.target.value })}
                    placeholder="00:1A:79:XX:XX:XX"
                  />
                </div>

                {/* Backup MACs */}
                <div className="form-group backup-section">
                  <label>Backup MAC Addresses</label>
                  <div className="backup-list">
                    {formData.backupMacs.map((mac, index) => (
                      <div key={index} className="backup-item">
                        <span className="backup-val">{mac}</span>
                        <div className="backup-actions">
                          <button
                            type="button"
                            className="swap-btn"
                            onClick={() => handleSwapCredential('stalker', index)}
                            title="Swap to this MAC"
                          >
                            Swap
                          </button>
                          <button
                            type="button"
                            className="delete-btn"
                            onClick={() => handleDeleteBackup('stalker', index)}
                            title="Delete backup"
                          >
                            Delete
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
                          Add
                        </button>
                        <button
                          type="button"
                          className="cancel-btn"
                          onClick={cancelAddBackupMac}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="add-backup-btn"
                      onClick={handleAddBackupMac}
                    >
                      + Add Backup MAC
                    </button>
                  )}
                </div>
              </>
            )}

            {formData.type === 'xtream' && (
              <>
                <div className="form-group">
                  <label>Username</label>
                  <input
                    type="text"
                    value={formData.username}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    placeholder="username"
                  />
                </div>
                <div className="form-group">
                  <label>Password</label>
                  <div className="password-input-wrapper">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      placeholder="password"
                    />
                    <button
                      type="button"
                      className="password-toggle-btn"
                      onClick={() => setShowPassword(!showPassword)}
                      title={showPassword ? 'Hide password' : 'Show password'}
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
                  <label>Backup Credentials</label>
                  <div className="backup-list">
                    {formData.backupCredentials.map((creds, index) => (
                      <div key={index} className="backup-item">
                        <span className="backup-val">User: {creds.username}</span>
                        <div className="backup-actions">
                          <button
                            type="button"
                            className="swap-btn"
                            onClick={() => handleSwapCredential('xtream', index)}
                            title="Swap to these credentials"
                          >
                            Swap
                          </button>
                          <button
                            type="button"
                            className="delete-btn"
                            onClick={() => handleDeleteBackup('xtream', index)}
                            title="Delete backup"
                          >
                            Delete
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
                        placeholder="Backup Username"
                        className="backup-input"
                        autoFocus
                      />
                      <div className="password-input-wrapper backup-password-wrapper">
                        <input
                          type={showBackupPassword ? 'text' : 'password'}
                          value={newBackupPass}
                          onChange={(e) => setNewBackupPass(e.target.value)}
                          placeholder="Backup Password"
                          className="backup-input"
                        />
                        <button
                          type="button"
                          className="password-toggle-btn backup-toggle-btn"
                          onClick={() => setShowBackupPassword(!showBackupPassword)}
                          title={showBackupPassword ? 'Hide password' : 'Show password'}
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
                          Add
                        </button>
                        <button
                          type="button"
                          className="cancel-btn"
                          onClick={cancelAddBackupCredential}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="add-backup-btn"
                      onClick={handleAddBackupCredential}
                    >
                      + Add Backup Credentials
                    </button>
                  )}
                </div>

                {!isEncryptionAvailable && (
                  <div className="inline-warning">
                    Warning: Password will be stored without encryption
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
                Auto-load EPG from source
              </label>
              <span className="hint">
                {formData.type === 'xtream'
                  ? 'Uses provider\'s XMLTV endpoint'
                  : 'Uses url-tvg from M3U header if available'}
              </span>
            </div>

            {!formData.autoLoadEpg && (
              <div className="form-group">
                <label>EPG URL (optional)</label>
                <input
                  type="text"
                  value={formData.epgUrl}
                  onChange={(e) => setFormData({ ...formData, epgUrl: e.target.value })}
                  placeholder="http://example.com/epg.xml"
                />
                <span className="hint">XMLTV format EPG URL</span>
              </div>
            )}

            <div className="form-group">
              <label>EPG Time Offset (hours)</label>
              <input
                type="number"
                value={formData.epgTimeshiftHours}
                onChange={(e) => setFormData({ ...formData, epgTimeshiftHours: parseInt(e.target.value) || 0 })}
                placeholder="0"
                min="-12"
                max="12"
                step="1"
              />
              <span className="hint">Adjust if EPG times are incorrect (e.g., -1 for 1 hour earlier)</span>
            </div>

            <div className="form-group">
              <label>User Agent (Optional)</label>
              <input
                type="text"
                value={formData.userAgent}
                onChange={(e) => setFormData({ ...formData, userAgent: e.target.value })}
                placeholder="Ex: Mozilla/5.0..."
              />
              <span className="hint">Custom User-Agent header for requests</span>
            </div>

            <div className="form-actions">
              <button type="button" className="cancel-btn" onClick={handleCancel}>
                Cancel
              </button>
              <button type="submit" className="save-btn">
                {editingId ? 'Save Changes' : 'Add Source'}
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
            <h3>Delete Source</h3>
            <p style={{ color: 'rgba(255,255,255,0.8)', marginBottom: '24px', lineHeight: '1.5' }}>
              Are you sure you want to delete <strong>"{deleteConfirm.name}"</strong>?
              <br /><br />
              This will remove all channels, EPG, and VOD data from this source.
            </p>
            <div className="form-actions" style={{ marginTop: '0' }}>
              <button
                className="cancel-btn"
                onClick={() => setDeleteConfirm(null)}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                className="save-btn"
                onClick={confirmDelete}
                disabled={isDeleting}
                style={{ borderColor: '#ff4444', color: '#ff4444', background: 'rgba(255, 68, 68, 0.1)' }}
              >
                {isDeleting ? 'Deleting...' : 'Yes, Delete'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
